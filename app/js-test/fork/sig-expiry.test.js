const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/sig-age');
include('app/js/fork/sig-expiry');

describe('Site expiry', () => {
	const H = 3600000;
	const now = Date.UTC(2026, 9, 19, 12, 0, 0);
	const at = hoursFromNow => {
		const d = new Date(now + hoursFromNow * H);
		const p = n => String(n).padStart(2, '0');
		return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
	};
	const site = (leftH, extra) => Object.assign({ type: 'combat', lifeLength: 604800, lifeTime: at(leftH - 168), lifeLeft: at(leftH) }, extra);
	const state = s => { const r = sigExpiry.stateFor(s, now); return r && r.state; };

	describe('defaultLifeSeconds', () => {
		const opts = { signatures: { pasteLife: 72 } };
		it('sites get 7 days by default', () => {
			['combat', 'data', 'relic', 'gas', 'ore', 'Combat'].forEach(t => assert.equal(sigExpiry.defaultLifeSeconds(t, opts), 604800, t));
		});
		it('unknown counts as a site', () => {
			assert.equal(sigExpiry.defaultLifeSeconds('unknown', opts), 604800);
			assert.equal(sigExpiry.defaultLifeSeconds(undefined, opts), 604800);
		});
		it('wormholes get the paste default', () => {
			assert.equal(sigExpiry.defaultLifeSeconds('wormhole', opts), 72 * 3600);
			assert.equal(sigExpiry.defaultLifeSeconds('Wormhole', { signatures: { pasteLife: '24' } }), 24 * 3600);
		});
		it('missing options use the defaults', () => {
			assert.equal(sigExpiry.defaultLifeSeconds('data', undefined), 604800);
			assert.equal(sigExpiry.defaultLifeSeconds('wormhole', {}), 72 * 3600);
		});
		it('custom site life', () => {
			assert.equal(sigExpiry.defaultLifeSeconds('relic', { sigExpiry: { siteLife: 336 } }), 336 * 3600);
			assert.equal(sigExpiry.defaultLifeSeconds('relic', { sigExpiry: { siteLife: '672' } }), 672 * 3600);
			assert.equal(sigExpiry.defaultLifeSeconds('wormhole', { sigExpiry: { siteLife: 336 }, signatures: { pasteLife: 48 } }), 48 * 3600);
		});
		it('bad site life falls back to 7 days', () => assert.equal(sigExpiry.defaultLifeSeconds('gas', { sigExpiry: { siteLife: 'x' } }), 604800));
	});

	describe('holeLifeSeconds (a pasted site turns out to be a hole)', () => {
		const opts = { signatures: { pasteLife: 72 } };
		it('the paste default from now: fresh sig', () => assert.equal(sigExpiry.holeLifeSeconds({ lifeTime: at(-1) }, opts, now), 73 * 3600));
		it('an old site never comes out expired', () => {
			const sig = { lifeTime: at(-120) };
			const left = sigExpiry.parseServerTime(sig.lifeTime) + sigExpiry.holeLifeSeconds(sig, opts, now) * 1000;
			assert.equal(left, now + 72 * H);
		});
		it('a never-expiring sig: the paste default (the server restarts its lifeTime)', () => {
			assert.equal(sigExpiry.holeLifeSeconds({ lifeLength: 0, lifeTime: at(-120) }, opts, now), 72 * 3600);
			assert.equal(sigExpiry.holeLifeSeconds({ lifeLength: '0', lifeTime: at(-120) }, opts, now), 72 * 3600);
		});
		it('unknown or future lifeTime: the paste default', () => {
			assert.equal(sigExpiry.holeLifeSeconds({}, opts, now), 72 * 3600);
			assert.equal(sigExpiry.holeLifeSeconds({ lifeTime: at(2) }, opts, now), 72 * 3600);
			assert.equal(sigExpiry.holeLifeSeconds(undefined, {}, now), 72 * 3600);
		});
	});

	describe('updateLifeSeconds (a paste updates an existing site)', () => {
		const opts = { signatures: { pasteLife: 72 } };
		it('never-expiring sigs stay that way', () => assert.equal(sigExpiry.updateLifeSeconds({ lifeLength: 0, lifeTime: at(-50) }, 'data', opts, now), 0));
		it('a life the user extended is kept', () => {
			assert.equal(sigExpiry.updateLifeSeconds({ lifeLength: 14 * 86400, lifeTime: at(-6.5 * 24) }, 'data', opts, now), 14 * 86400);
		});
		it('an old site gets the default counted from now', () => {
			const sig = { lifeLength: 72 * 3600, lifeTime: at(-60) };
			assert.equal(sigExpiry.updateLifeSeconds(sig, 'combat', opts, now), (168 + 60) * 3600);
		});
		it('a fresh site gets the default', () => assert.equal(sigExpiry.updateLifeSeconds({ lifeLength: 604800, lifeTime: at(0) }, 'relic', opts, now), 604800));
		it('bad lifeTime: the default', () => {
			assert.equal(sigExpiry.updateLifeSeconds({ lifeLength: 3600, lifeTime: 'junk' }, 'gas', opts, now), 604800);
			assert.equal(sigExpiry.updateLifeSeconds(undefined, 'gas', opts, now), 604800);
		});
	});

	describe('lifeAfterTypeChange (Add dialog)', () => {
		const opts = { signatures: { pasteLife: 72 } };
		it('site default -> wormhole default', () => assert.equal(sigExpiry.lifeAfterTypeChange('604800', 'wormhole', opts), 72 * 3600));
		it('wormhole default -> site default', () => assert.equal(sigExpiry.lifeAfterTypeChange(72 * 3600, 'data', opts), 604800));
		it('site to site leaves it', () => assert.equal(sigExpiry.lifeAfterTypeChange(604800, 'relic', opts), null));
		it('a typed value stays', () => {
			assert.equal(sigExpiry.lifeAfterTypeChange(5 * 3600, 'wormhole', opts), null);
			assert.equal(sigExpiry.lifeAfterTypeChange(5 * 3600, 'combat', opts), null);
		});
		it("a wormhole type's life stays", () => assert.equal(sigExpiry.lifeAfterTypeChange(16 * 3600, 'combat', opts), null));
		it('nothing to switch when both defaults are equal', () => {
			assert.equal(sigExpiry.lifeAfterTypeChange(168 * 3600, 'wormhole', { signatures: { pasteLife: 168 } }), null);
		});
	});

	describe('stateFor', () => {
		it('more than 24 h left: none', () => assert.equal(state(site(24.01)), null));
		it('24 h left: soon', () => assert.equal(state(site(24)), 'soon'));
		it('between 4 and 24 h: soon', () => assert.equal(state(site(10)), 'soon'));
		it('just over 4 h: soon', () => assert.equal(state(site(4.01)), 'soon'));
		it('4 h left: critical', () => assert.equal(state(site(4)), 'critical'));
		it('past its end: critical', () => assert.equal(state(site(-0.5)), 'critical'));
		it('reports the time left', () => assert.deepEqual(sigExpiry.stateFor(site(3), now), { state: 'critical', remainingMs: 3 * H }));
		it('unknown sigs count down too', () => assert.equal(state(site(3, { type: 'unknown' })), 'critical'));
		it('wormholes: none (EOL has its own countdown)', () => assert.equal(state(site(3, { type: 'wormhole' })), null));
		it('never-expiring sigs: none', () => assert.equal(state(site(3, { lifeLength: 0 })), null));
		it('unknown expiry: none', () => {
			assert.equal(state(site(3, { lifeLeft: 'junk' })), null);
			assert.equal(state(site(3, { lifeLeft: null })), null);
		});
		it('no sig: none', () => assert.equal(sigExpiry.stateFor(undefined, now), null));
	});

	describe('enabled and settings', () => {
		it('on by default', () => {
			assert.ok(sigExpiry.enabled(undefined));
			assert.ok(sigExpiry.enabled({}));
			assert.ok(sigExpiry.enabled({ sigExpiry: { siteLife: 336 } }));
		});
		it('off when switched off', () => assert.ok(!sigExpiry.enabled({ sigExpiry: { enabled: false } })));
		it('each row keeps the other field', () => {
			const o = { sigExpiry: { siteLife: 336 } };
			o.sigExpiry = sigExpiry.withField(o, 'enabled', false);
			assert.deepEqual(o.sigExpiry, { siteLife: 336, enabled: false });
			o.sigExpiry = sigExpiry.withField(o, 'siteLife', 72);
			assert.deepEqual(o.sigExpiry, { siteLife: 72, enabled: false });
			assert.deepEqual(sigExpiry.withField({}, 'siteLife', 168), { siteLife: 168 });
		});
		it('registered Settings rows store into the shared key', () => {
			const rows = [];
			global.forkSettings = { register: def => rows.push(def) };
			try { sigExpiry.setupSettings(); } finally { delete global.forkSettings; }
			const life = rows.find(r => r.id === 'sigExpiry-siteLife'), on = rows.find(r => r.id === 'sigExpiry-enabled');
			assert.equal(life.order, 25);
			assert.equal(on.order, 45);
			const o = { sigExpiry: { enabled: false } };
			assert.equal(life.get(o), '168');
			life.set(o, '336');
			assert.deepEqual(o.sigExpiry, { enabled: false, siteLife: 336 });
			on.set(o, true);
			assert.deepEqual(o.sigExpiry, { enabled: true, siteLife: 336 });
			assert.equal(life.get(o), '336');
			assert.equal(life.get({ sigExpiry: { siteLife: 5 } }), '168');	// not a choice: shows the default
		});
	});

	describe('note and tooltip', () => {
		it('formats the time left', () => {
			assert.equal(sigExpiry.formatLeft(40 * 60000), '40 min');
			assert.equal(sigExpiry.formatLeft(3 * H + 20 * 60000), '3 h 20 min');
			assert.equal(sigExpiry.formatLeft(5 * H), '5 h');
			assert.equal(sigExpiry.formatLeft(15.5 * H), '15 h');
		});
		it('notes', () => {
			assert.equal(sigExpiry.note({ state: 'soon', remainingMs: 15 * H }), 'Expires in 15 h (edit its life to keep it)');
			assert.equal(sigExpiry.note({ state: 'critical', remainingMs: -1 }), 'Expires now: Tripwire deletes it within a minute');
			assert.equal(sigExpiry.note(null), '');
		});
		it('composes with the age line in the upstream tooltip', () => {
			const base = "<table class='age-tooltip-table'><tr><td>Created</td></tr></table>";
			const out = sigAge.composeTooltip(base, [{ text: 'Expires in 5 h', cls: 'sig-expiry-note' }, { text: 'Stale: not updated for 3 d', cls: 'sig-age-note' }]);
			assert.equal(out, "<table class='age-tooltip-table'><tr><td>Created</td></tr>"
				+ '<tr><td colspan="3" class="sig-expiry-note">Expires in 5 h</td></tr>'
				+ '<tr><td colspan="3" class="sig-age-note">Stale: not updated for 3 d</td></tr></table>');
		});
		it('setNote: the age and expiry lines keep each other', () => {
			const store = {}, attrs = { 'data-tooltip': '<table><tr><td>Created</td></tr></table>' };
			const $cell = {
				data: (k, v) => { if (v === undefined) { return store[k]; } store[k] = v; },
				attr: (k, v) => { if (v === undefined) { return attrs[k]; } attrs[k] = v; }
			};
			sigAge.setNote($cell, 'age', 'Aging: not updated for 30 h');
			sigAge.setNote($cell, 'expiry', 'Expires in 5 h');
			assert.ok(attrs['data-tooltip'].indexOf('Expires in 5 h') > 0);
			assert.ok(attrs['data-tooltip'].indexOf('Expires in 5 h') < attrs['data-tooltip'].indexOf('Aging'));
			sigAge.setNote($cell, 'age', '');	// sig-age's minute tick rebuilds from upstream's tooltip
			assert.equal(attrs['data-tooltip'], '<table><tr><td>Created</td></tr><tr><td colspan="3" class="sig-expiry-note">Expires in 5 h</td></tr></table>');
			sigAge.setNote($cell, 'expiry', '');
			assert.equal(attrs['data-tooltip'], '<table><tr><td>Created</td></tr></table>');
		});
		it('empty notes leave the upstream tooltip as it is', () => {
			assert.equal(sigAge.composeTooltip('<table></table>', [{ text: '', cls: 'a' }]), '<table></table>');
			assert.equal(sigAge.composeTooltip('plain', [{ text: 'x', cls: 'a' }]), 'plainx');
		});
	});
});
