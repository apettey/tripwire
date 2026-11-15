const assert = require('assert');
const { include } = require('../helpers/helpers');

// app/js/fork/upstream-2-adapters.js: patches applied once, at load, to upstream 2.0 globals
describe('Upstream 2.0 adapters', () => {
	const GLOBALS = ['tripwire', 'chain', 'sanitiseHtml', '$'];
	const saved = {};
	let fetched = 0, hidden = [];

	before(() => {
		GLOBALS.forEach(g => { saved[g] = global[g]; });
		global.$ = sel => ({ addClass(c) { hidden.push(sel + '+' + c); return this; }, removeClass(c) { hidden.push(sel + '-' + c); return this; } });
		global.chain = { data: {} };
		global.sanitiseHtml = html => 'clean:' + html;
		global.tripwire = {
			killStream: { isWormhole: () => true, refresh: () => { fetched++; } },
			editor: { replace: id => ({ id: id, getData: () => '<img src=x onerror=alert(1)>' }) }
		};
		include('app/js/fork/upstream-2-adapters');
	});
	after(() => {
		GLOBALS.forEach(g => { if (saved[g] === undefined) delete global[g]; else global[g] = saved[g]; });
	});

	it('starts the chain with no flares, so systemPanel.update can read them on the first draw', () => {
		assert.deepStrictEqual(chain.data.flares, {});
	});
	it('the kill stream never fetches from zKillboard and the activity graph stays in J-space', () => {
		tripwire.killStream.refresh(31000005);
		assert.strictEqual(fetched, 0);
		assert.strictEqual(tripwire.killStream.isWormhole(31000005), false);
		assert.deepStrictEqual(hidden, ['#killStream+hidden', '#infoWidget-is-wormhole']);
	});
	it('the note editor hands back sanitised HTML', () => {
		const inst = tripwire.editor.replace('comment1');
		assert.strictEqual(inst.id, 'comment1');
		assert.strictEqual(inst.getData(), 'clean:<img src=x onerror=alert(1)>');
		assert.strictEqual(tripwire.editor.sanitiseWrapped, true);
	});
});
