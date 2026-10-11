const assert = require('assert');
const { JSDOM } = require('jsdom');
const { include, loadJSON } = require('../helpers/helpers');

global.DOMParser = new JSDOM('').window.DOMParser;
include('app/js/fork/sanitise-html');

// The same cases are run against the PHP sanitiser (tests/note_html_test.php).
describe('sanitiseHtml (system notes)', () => {
	loadJSON('app/js-test/testdata/note-html-cases').forEach(c => {
		it(c.name, () => {
			const out = sanitiseHtml(c.input);
			(c.contains || []).forEach(s => assert.ok(out.includes(s), 'missing ' + s + ' in ' + out));
			(c.notContains || []).forEach(s => assert.ok(!out.toLowerCase().includes(s.toLowerCase()), 'unexpected ' + s + ' in ' + out));
		});
	});

	it('adds rel to links that open a new tab', () => {
		assert.ok(/rel="noopener noreferrer"/.test(sanitiseHtml('<a href="https://x.example/" target="_blank">x</a>')));
	});
	it('handles null', () => assert.equal(sanitiseHtml(null), ''));
});
