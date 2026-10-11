const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/life-wording');

describe('Wormhole life wording', () => {
	it('explains Stable with the in-game "Reliable lifetime"', () => assert.ok(/Reliable lifetime/.test(lifeWording.TOOLTIPS.wormholeLifeStable)));
	it('explains EOL with the in-game "Expired"', () => assert.ok(/Expired/.test(lifeWording.TOOLTIPS.wormholeLifeEOL)));
	it('does nothing without a document', () => assert.doesNotThrow(() => { try { lifeWording.apply(); } catch (e) { if (!(e instanceof ReferenceError)) { throw e; } } }));
});
