const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/panel-small-views');

describe('Small views of upstream panels', () => {
	const sv = () => panelSmallViews;
	const SYS = 31001880;
	const sig = (id, o) => Object.assign({ id: String(id), signatureID: 'abc' + id, systemID: SYS, type: 'combat', name: '', lifeTime: '2026-10-18 12:00:00' }, o || {});

	describe('unscanned', () => {
		it('a signature whose group is not identified: type "unknown" or no type', () => {
			assert.equal(sv().isUnscanned(sig(1, { type: 'unknown' })), true);
			assert.equal(sv().isUnscanned(sig(1, { type: 'Unknown ' })), true);
			assert.equal(sv().isUnscanned(sig(1, { type: '' })), true);
			assert.equal(sv().isUnscanned(sig(1, { type: null })), true);
			assert.equal(sv().isUnscanned(sig(1, { type: undefined })), true);
		});
		it('wormholes and sites are scanned, whatever else is missing', () => {
			['wormhole', 'combat', 'data', 'relic', 'ore', 'gas'].forEach(t => assert.equal(sv().isUnscanned(sig(1, { type: t, signatureID: '' })), false, t));
			assert.equal(sv().isUnscanned(null), false);
		});
	});

	describe('the list', () => {
		const sigs = {
			1: sig(1, { type: 'unknown' }),
			2: sig(2, { systemID: 30000142 }),			// another system
			3: sig(3, { bookmark: 'anomaly' }),
			4: sig(4, { type: 'wormhole', systemID: String(SYS) })
		};
		it('the viewed system only, without the hidden ones', () => {
			assert.deepEqual(sv().visible(sigs, SYS, []).map(s => s.id), ['1', '3', '4']);
			assert.deepEqual(sv().visible(sigs, String(SYS), [3]).map(s => s.id), ['1', '4']);
			assert.deepEqual(sv().visible(null, SYS), []);
		});
		it('counts the total and the unscanned', () => {
			assert.deepEqual(sv().counts(sv().visible(sigs, SYS, [])), { total: 3, unscanned: 1 });
			assert.deepEqual(sv().counts([]), { total: 0, unscanned: 0 });
		});
		it('header text: quiet when empty, the unscanned part only when there are some', () => {
			assert.deepEqual(sv().headText({ total: 0, unscanned: 0 }), { total: 'No signatures', unscanned: '' });
			assert.deepEqual(sv().headText({ total: 1, unscanned: 0 }), { total: '1 signature', unscanned: '' });
			assert.deepEqual(sv().headText({ total: 5, unscanned: 2 }), { total: '5 signatures', unscanned: '2 unscanned' });
		});
	});

	describe('newest signatures', () => {
		const list = [
			sig(10, { lifeTime: '2026-10-18 10:00:00' }),
			sig(11, { lifeTime: '2026-10-18 12:30:00' }),
			sig(12, { lifeTime: '2026-10-18 12:30:00' }),	// same time: the later added (higher id) first
			sig(13, { lifeTime: null }),					// unknown time: last
			sig(14, { lifeTime: '2026-10-17 23:59:59' })
		];
		it('newest first, ties by id, unknown times last', () => {
			assert.deepEqual(sv().newest(list).map(s => s.id), ['12', '11', '10', '14', '13']);
		});
		it('at most the limit (default MAX_ROWS); never mutates', () => {
			assert.deepEqual(sv().newest(list, 2).map(s => s.id), ['12', '11']);
			assert.equal(sv().newest(list, 0).length, 0);
			assert.equal(list[0].id, '10');
			const many = Array.from({ length: 50 }, (x, i) => sig(i));
			assert.equal(sv().newest(many).length, sv().MAX_ROWS);
		});
	});

	describe('row parts', () => {
		it('signature ID as the list shows it', () => {
			assert.equal(sv().sigID('abc123'), 'ABC-123');
			assert.equal(sv().sigID('ABC'), 'ABC');
			assert.equal(sv().sigID(''), '???');
			assert.equal(sv().sigID(null), '???');
			assert.equal(sv().sigID('???'), '???');
			assert.equal(sv().sigID("a<b>c'1"), 'ABC-1');
		});
		it('type: ? when unscanned, the hole type (own end) or [type] (far end), WH without one, else the group', () => {
			const wh = { initialID: '1', secondaryID: '2', parent: 'initial', type: 'H296' };
			assert.equal(sv().typeText(sig(1, { type: 'unknown' })), '?');
			assert.equal(sv().typeText(sig(1, { type: 'wormhole' }), wh), 'H296');
			assert.equal(sv().typeText(sig(2, { type: 'wormhole' }), wh), '[H296]');
			assert.equal(sv().typeText(sig(1, { type: 'wormhole' }), Object.assign({}, wh, { type: '' })), '???');
			assert.equal(sv().typeText(sig(1, { type: 'wormhole' }), Object.assign({}, wh, { parent: null })), 'WH');
			assert.equal(sv().typeText(sig(1, { type: 'wormhole' })), 'WH');
			assert.equal(sv().typeText(sig(1, { type: 'data' })), 'data');
		});
		it('age: now, minutes, hours, days', () => {
			assert.equal(sv().age(59 * 1000), 'now');
			assert.equal(sv().age(-5000), 'now');
			assert.equal(sv().age(12 * 60000), '12m');
			assert.equal(sv().age(5 * 3600000 + 59 * 60000), '5h');
			assert.equal(sv().age(3 * 86400000), '3d');
		});
		it('server times (UTC)', () => {
			assert.equal(sv().parseTime('2026-10-18 12:00:00'), Date.UTC(2026, 9, 18, 12, 0, 0));
			assert.ok(isNaN(sv().parseTime('')));
		});
		it('escapes text', () => {
			assert.equal(sv().escape("<b>'x'&\""), '&lt;b&gt;&#39;x&#39;&amp;&quot;');
			assert.equal(sv().escape(null), '');
		});
	});
});
