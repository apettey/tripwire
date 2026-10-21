const assert = require('assert');
const { JSDOM } = require('jsdom');
const { include } = require('../helpers/helpers');

include('app/js/fork/csrf');

describe('forkCsrf (X-CSRF-Token on upstream POSTs)', () => {
	it('reads the token from the page meta tag', () => {
		const doc = new JSDOM('<head><meta name="csrf-token" content="abc"></head>').window.document;
		assert.equal(forkCsrf.token(doc), 'abc');
		assert.equal(forkCsrf.token(new JSDOM('').window.document), '');
	});

	it('adds the token to same-origin POSTs', () => {
		assert.equal(forkCsrf.headerFor({ type: 'POST', url: 'options.php' }, 'abc'), 'abc');
		assert.equal(forkCsrf.headerFor({ method: 'post', url: 'masks.php' }, 'abc'), 'abc');
	});

	it('leaves GETs, cross-origin requests and pages without a token alone', () => {
		assert.equal(forkCsrf.headerFor({ type: 'GET', url: 'refresh.php' }, 'abc'), null);
		assert.equal(forkCsrf.headerFor({ url: 'refresh.php' }, 'abc'), null);
		assert.equal(forkCsrf.headerFor({ type: 'POST', url: 'https://esi.evetech.net/', crossDomain: true }, 'abc'), null);
		assert.equal(forkCsrf.headerFor({ type: 'POST', url: 'options.php' }, ''), null);
	});

	it('keeps a token the request already sets', () => {
		assert.equal(forkCsrf.headerFor({ type: 'POST', headers: { 'X-CSRF-Token': 'own' } }, 'abc'), null);
	});

	it('installs one prefilter that sets the header', () => {
		const filters = [];
		const $ = { ajaxPrefilter: f => filters.push(f) };
		const doc = new JSDOM('<head><meta name="csrf-token" content="abc"></head>').window.document;
		forkCsrf.install($, doc);
		forkCsrf.install($, doc);
		assert.equal(filters.length, 1);
		const set = {};
		filters[0]({ type: 'POST' }, {}, { setRequestHeader: (k, v) => { set[k] = v; } });
		assert.deepEqual(set, { 'X-CSRF-Token': 'abc' });
	});
});
