const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/sig-age');

describe('Signature age colouring', () => {
	const H = 3600000;
	const now = Date.UTC(2026, 9, 10, 12, 0, 0);
	const at = hoursAgo => {
		const d = new Date(now - hoursAgo * H);
		const p = n => String(n).padStart(2, '0');
		return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
	};
	const sig = (createdH, modifiedH, extra) => Object.assign({ type: 'data', lifeLength: 259200, lifeTime: at(createdH), modifiedTime: at(modifiedH) }, extra);
	const level = (s, wh) => { const r = sigAge.levelFor(s, wh, now); return r && r.level; };

	describe('parseServerTime', () => {
		it('reads server time as UTC', () => assert.equal(sigAge.parseServerTime('2026-10-10 12:00:00'), now));
		it('accepts a T separator and no seconds', () => assert.equal(sigAge.parseServerTime('2026-10-10T12:00'), now));
		it('is NaN for junk', () => { assert.ok(isNaN(sigAge.parseServerTime('nope'))); assert.ok(isNaN(sigAge.parseServerTime(null))); });
	});

	describe('levelFor signatures', () => {
		it('fresh under 4.5 h', () => assert.equal(level(sig(4.4, 4.4)), 'fresh'));
		it('aging from 4.5 h', () => assert.equal(level(sig(4.5, 4.5)), 'aging'));
		it('stale from 24 h', () => assert.equal(level(sig(24, 24)), 'stale'));
		it('uses the last change, not the creation time', () => assert.equal(level(sig(30, 1)), 'fresh'));
		it('falls back to creation time without modifiedTime', () => assert.equal(level(sig(6, 0, { modifiedTime: null })), 'aging'));
		it('never-expiring sigs (lifeLength 0) are not coloured', () => assert.equal(level(sig(30, 30, { lifeLength: 0 })), null));
		it('unknown times are not coloured', () => assert.equal(level({ type: 'data', lifeTime: '', modifiedTime: '' }), null));
		it('no sig, no level', () => assert.equal(sigAge.levelFor(undefined, undefined, now), null));
		it('a time in the future counts as fresh', () => assert.deepEqual(sigAge.levelFor(sig(-1, -1), undefined, now), { level: 'fresh', ageMs: 0 }));
		it('custom thresholds', () => assert.equal(sigAge.levelFor(sig(2, 2), undefined, now, { signature: { aging: 1, stale: 2 } }).level, 'stale'));
	});

	describe('levelFor wormholes', () => {
		const wh = (life, type) => ({ life: life || 'stable', type: type || 'H296' });
		const hole = h => sig(h, h, { type: 'wormhole', lifeLength: 86400 });
		it('fresh under 12 h', () => assert.equal(level(hole(11), wh()), 'fresh'));
		it('aging from 12 h', () => assert.equal(level(hole(12), wh()), 'aging'));
		it('stale from 24 h', () => assert.equal(level(hole(24), wh()), 'stale'));
		it('EOL holes are left to the EOL countdown', () => assert.equal(level(hole(30), wh('critical')), null));
		it('gates are not coloured', () => assert.equal(level(hole(30), wh('stable', 'GATE')), null));
		it('wormhole thresholds apply without a wormhole record', () => assert.equal(level(hole(6)), 'fresh'));
	});

	describe('formatAge and note', () => {
		it('minutes', () => assert.equal(sigAge.formatAge(40 * 60000), '40 min'));
		it('half hours under 10 h', () => { assert.equal(sigAge.formatAge(4.6 * H), '4.5 h'); assert.equal(sigAge.formatAge(5.2 * H), '5 h'); });
		it('whole hours to 48 h', () => assert.equal(sigAge.formatAge(30.9 * H), '30 h'));
		it('days and hours from 48 h', () => { assert.equal(sigAge.formatAge(51 * H), '2 d 3 h'); assert.equal(sigAge.formatAge(72 * H), '3 d'); });
		it('notes for aging and stale only', () => {
			assert.equal(sigAge.note({ level: 'aging', ageMs: 5 * H }), 'Aging: not updated for 5 h');
			assert.equal(sigAge.note({ level: 'stale', ageMs: 30 * H }), 'Stale: not updated for 30 h');
			assert.equal(sigAge.note({ level: 'fresh', ageMs: H }), '');
			assert.equal(sigAge.note(null), '');
		});
	});

	describe('serverNow (clock skew)', () => {
		const local = Date.UTC(2026, 9, 10, 15, 0, 0);	// PC clock 3 h fast
		it('uses the local clock without a server time', () => assert.equal(sigAge.serverNow(undefined, local, { serverMs: null, offset: 0 }), local));
		it('corrects to the server time from the last sync', () => {
			const clock = { serverMs: null, offset: 0 };
			assert.equal(sigAge.serverNow(new Date(now), local, clock), now);
			// a minute later, same sync: the clock keeps running with the measured offset
			assert.equal(sigAge.serverNow(new Date(now), local + 60000, clock), now + 60000);
		});
		it('re-measures on the next sync', () => {
			const clock = { serverMs: null, offset: 0 };
			sigAge.serverNow(new Date(now), local, clock);
			assert.equal(sigAge.serverNow(now + 120000, local + 60000, clock), now + 120000);
		});
		it('keeps the last offset when the server time goes missing', () => {
			const clock = { serverMs: null, offset: 0 };
			sigAge.serverNow(new Date(now), local, clock);
			assert.equal(sigAge.serverNow(undefined, local + 1000, clock), now + 1000);
			assert.equal(sigAge.serverNow(new Date('junk'), local + 2000, clock), now + 2000);
		});
		it('skewed PC clock no longer changes the level', () => {
			const clock = { serverMs: null, offset: 0 };
			const s = sig(3, 3);	// 3 h old by server time: fresh
			assert.equal(sigAge.levelFor(s, undefined, local).level, 'aging');	// uncorrected: 6 h
			assert.equal(sigAge.levelFor(s, undefined, sigAge.serverNow(new Date(now), local, clock)).level, 'fresh');
		});
	});

	describe('enabled', () => {
		it('on by default', () => { assert.ok(sigAge.enabled(undefined)); assert.ok(sigAge.enabled({})); assert.ok(sigAge.enabled({ sigAge: {} })); });
		it('off when switched off', () => assert.ok(!sigAge.enabled({ sigAge: { enabled: false } })));
	});
});
