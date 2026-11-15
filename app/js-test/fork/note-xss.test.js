// XSS payload corpus for system notes (app/js-test/testdata/note-xss-corpus.json), run against the browser sanitiser.
// tests/note_xss_test.php runs the same corpus against the server sanitiser (note-html.inc.php).
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { include, loadJSON } = require('../helpers/helpers');

global.DOMParser = new JSDOM('').window.DOMParser;
include('app/js/fork/sanitise-html');

const TAGS = ['b', 'i', 'em', 'strong', 'u', 's', 'strike', 'sub', 'sup', 'code', 'small', 'font', 'span', 'p', 'br', 'hr',
	'div', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td',
	'th', 'a', 'img'];
const ATTRS = { '*': ['style', 'title', 'dir'], a: ['href', 'target', 'rel'], font: ['color', 'size', 'face'],
	table: ['border', 'cellpadding', 'cellspacing', 'align', 'width'], td: ['colspan', 'rowspan', 'align', 'width'],
	th: ['colspan', 'rowspan', 'align', 'width'], img: ['src', 'alt', 'width', 'height'] };

/** Problems with sanitised HTML, parsed the way a browser shows it: [] when it is safe */
function problems(html) {
	const out = [];
	const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
	doc.body.querySelectorAll('*').forEach(el => {
		const tag = el.tagName.toLowerCase();
		if (TAGS.indexOf(tag) < 0 || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') { out.push('element ' + tag); }
		Array.from(el.attributes).forEach(a => {
			const name = a.name.toLowerCase();
			const value = a.value.replace(/[\x00-\x20\x7f]/g, '');
			if (ATTRS['*'].indexOf(name) < 0 && (ATTRS[tag] || []).indexOf(name) < 0) { out.push(tag + ' @' + name); }
			if (name === 'href' && !/^(?:https?:|mailto:|\/|#|\.{0,2}\/)/i.test(value)) { out.push('href ' + a.value); }
			if (name === 'src' && !/^https?:\/\//i.test(value)) { out.push('src ' + a.value); }
			if (name === 'style' && /url|expression|binding|behaviou?r|position|@import|\\/i.test(a.value)) { out.push('style ' + a.value); }
		});
	});
	return out;
}

describe('Note XSS corpus (browser sanitiser)', () => {
	loadJSON('app/js-test/testdata/note-xss-corpus').forEach(c => {
		it(c.name, () => {
			const out = sanitiseHtml(c.input);
			assert.deepStrictEqual(problems(out), [], out);
			(c.contains || []).forEach(s => assert.ok(out.includes(s), 'missing ' + s + ' in ' + out));
			// Stable: cleaning the result again changes nothing (no markup that re-parses into something else)
			assert.strictEqual(sanitiseHtml(out), out);
		});
	});

	it('the checker itself finds unsafe markup', () => {
		assert.ok(problems('<img src=x onerror=alert(1)>').length);
		assert.ok(problems('<a href="javascript:alert(1)">x</a>').length);
		assert.ok(problems('<svg></svg>').length);
		assert.deepStrictEqual(problems('<b>x</b><a href="https://example.com/">y</a>'), []);
	});
});
