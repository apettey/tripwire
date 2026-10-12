const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/leads-trim');

describe('leadsTrim', () => {
	const field = (value, matches) => ({ value: value, matches: () => matches !== false, dispatched: [], dispatchEvent(e) { this.dispatched.push(e.type); } });

	// A fake document that records listeners so the test can fire them
	function fakeDoc() {
		const listeners = {};
		return {
			listeners,
			addEventListener(type, fn, capture) { assert.strictEqual(capture, true); listeners[type] = fn; }
		};
	}

	it('trims a name copied from the game', () => {
		const el = field('J163701 ');
		assert.strictEqual(leadsTrim.trim(el), true);
		assert.strictEqual(el.value, 'J163701');
	});

	it('leaves inner spaces and clean values alone', () => {
		const el = field('New Caldari');
		assert.strictEqual(leadsTrim.trim(el), false);
		assert.strictEqual(el.value, 'New Caldari');
		const padded = field('  Unknown (small)\t');
		leadsTrim.trim(padded);
		assert.strictEqual(padded.value, 'Unknown (small)');
	});

	it('trims on change before the dialog sees it, only for the Leads To field', () => {
		const doc = fakeDoc();
		leadsTrim.install(doc);
		const leads = field('J163701 ');
		doc.listeners.change({ target: leads });
		assert.strictEqual(leads.value, 'J163701');
		const other = field('A ', false);
		doc.listeners.change({ target: other });
		assert.strictEqual(other.value, 'A ');
	});

	it('trims after a paste and tells the autocomplete', (done) => {
		const doc = fakeDoc();
		global.Event = global.Event || function(type) { this.type = type; };
		leadsTrim.install(doc);
		const leads = field('');
		doc.listeners.paste({ target: leads });
		leads.value = 'J163701 ';	// the pasted text lands after the event
		setTimeout(() => {
			assert.strictEqual(leads.value, 'J163701');
			assert.deepStrictEqual(leads.dispatched, ['input']);
			done();
		}, 5);
	});
});
