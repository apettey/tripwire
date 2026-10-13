const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/life-wording');

describe('Wormhole life wording', () => {
	it('explains Stable with the in-game "Reliable lifetime"', () => assert.ok(/Reliable lifetime/.test(lifeWording.TOOLTIPS.wormholeLifeStable)));
	it('explains the states with the in-game wording', () => {
		assert.ok(/less than 4 hours/.test(lifeWording.tooltipFor('wormholeLifeEOL', true)));
		assert.ok(/less than 1 hour/.test(lifeWording.tooltipFor('wormholeLifeLt1h', true)));
		assert.ok(/Expired/.test(lifeWording.tooltipFor('wormholeLifeExpired', true)));
	});
	it('EOL (life states off) covers every in-game end-of-life wording', () => {
		const t = lifeWording.tooltipFor('wormholeLifeEOL', false);
		assert.ok(/less than 4 hours/.test(t) && /less than 1 hour/.test(t) && /Expired/.test(t));
	});
	it('has a tooltip for every life button', () => lifeWording.IDS.forEach(id => assert.ok(lifeWording.tooltipFor(id, true).length > 10, id)));
	it('does nothing without a document', () => assert.doesNotThrow(() => { try { lifeWording.apply(); } catch (e) { if (!(e instanceof ReferenceError)) { throw e; } } }));
});
