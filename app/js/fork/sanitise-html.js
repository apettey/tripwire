// Adapted from mogglemoss/tripwire d9a458f (MIT).
// HTML sanitiser for user-authored content (system notes).
//
// Replaces a regex-based filter that was bypassable. The old one stripped
// disallowed tags and rewrote `on\w+=` to neutralise handlers, but the pattern
// required the equals sign to touch the attribute name -- so
//
//     <img src=x onerror =alert(1)>
//
// passed through untouched and executed on render, with no click, in the
// session of every corp member who opened the system. `javascript:` in an href
// was not filtered at all.
//
// Regexes cannot sanitise HTML: the parser accepts whitespace, newlines and
// entity encodings the pattern does not anticipate. This parses the input with
// the browser's own parser -- in an inert document, so nothing loads or
// executes while inspecting it -- then keeps only allowlisted elements and
// attributes and rebuilds the markup.

var sanitiseHtml = (function() {
	// Formatting CKEditor produces, and nothing that can navigate or execute.
	var ALLOWED_TAGS = {
		b:1, i:1, em:1, strong:1, u:1, s:1, strike:1, sub:1, sup:1, code:1, small:1,
		font:1, span:1, p:1, br:1, hr:1, div:1, pre:1, blockquote:1,
		h1:1, h2:1, h3:1, h4:1, h5:1, h6:1,
		ul:1, ol:1, li:1,
		table:1, thead:1, tbody:1, tr:1, td:1, th:1,
		a:1, img:1
	};

	// Per-tag attribute allowlist. Anything not named here is dropped, which is
	// what makes an unanticipated handler (onerror, onpointerover, on-anything)
	// impossible rather than merely unmatched.
	var ALLOWED_ATTRS = {
		'*': {style: 1, title: 1, dir: 1},
		a:   {href: 1, target: 1, rel: 1},
		font:{color: 1, size: 1, face: 1},
		table:{border: 1, cellpadding: 1, cellspacing: 1, align: 1, width: 1},
		td:  {colspan: 1, rowspan: 1, align: 1, width: 1},
		th:  {colspan: 1, rowspan: 1, align: 1, width: 1},
		// img was in the previous allowlist, so it stays -- dropping it would
		// silently strip pictures out of notes people already wrote. Worth
		// knowing: an image from an arbitrary host reveals the viewer's IP to
		// that host every time the note is opened. If that matters to the corp,
		// remove img here and the concern goes with it.
		img: {src: 1, alt: 1, width: 1, height: 1}
	};

	// Schemes a link may use. Relative URLs are allowed and everything else --
	// javascript:, data:, vbscript: -- is not.
	var SAFE_URL = /^(?:https?:|mailto:|\/|#|\.{0,2}\/)/i;
	// Images: absolute http(s) only. A relative src would let a note fire a GET at this site (/comments.php?mode=delete).
	var SAFE_IMG_URL = /^https?:\/\//i;
	// Elements removed together with their content (their text is raw markup to some parsers).
	var DROP_WITH_CONTENT = {script:1, style:1, xmp:1, iframe:1, noscript:1, template:1, object:1, embed:1, noembed:1, noframes:1, plaintext:1, textarea:1, title:1, head:1, svg:1, math:1};
	var NUMERIC_ATTR = /^(?:\d+%?|left|right|center)$/i;

	// style is kept because notes use colour, but anything that can fetch or
	// execute from within CSS is removed.
	var UNSAFE_CSS = /(?:expression|javascript:|vbscript:|url\s*\(|@import|behaviou?r\s*:|-moz-binding)/i;
	var SAFE_STYLES = {
		color: /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s+-]+\)|[a-z]+)$/i,
		'background-color': /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s+-]+\)|[a-z]+)$/i,
		// A deliberately finite set keeps notes readable and prevents stored
		// content from taking over the panel while preserving common rich-text
		// sizes from older editors.
		'font-size': /^(?:(?:8|9|10|11|12|13|14|16|18|20|22|24|26|28|32|36|48|72)px|(?:0\.75|0\.875|1|1\.125|1\.25|1\.5|2|2\.5|3)(?:em|rem)|(?:75|80|87\.5|100|112\.5|125|150|200|250|300)%|xx-small|x-small|small|medium|large|x-large|xx-large)$/i,
		'text-align': /^(?:left|right|center|justify|start|end)$/i,
		'font-weight': /^(?:normal|bold|bolder|lighter|[1-9]00)$/i,
		'font-style': /^(?:normal|italic|oblique)$/i,
		'text-decoration': /^(?:(?:none|underline|overline|line-through)\s*)+$/i,
		'font-family': /^[a-z0-9 ,'"\-]+$/i,
		'margin-left': /^\d+px$/,
		'padding-left': /^\d+px$/
	};

	function cleanStyle(value) {
		if (UNSAFE_CSS.test(value)) { return null; }

		var declarations = [];
		value.split(';').forEach(function(declaration) {
			var colon = declaration.indexOf(':');
			if (colon < 1) { return; }
			var property = declaration.slice(0, colon).trim().toLowerCase();
			var propertyValue = declaration.slice(colon + 1).trim();
			if (SAFE_STYLES[property] && SAFE_STYLES[property].test(propertyValue)) {
				declarations.push(property + ': ' + propertyValue);
			}
		});
		return declarations.length ? declarations.join('; ') : null;
	}

	// The path of a URL, percent-decoded, so %2e%70hp cannot hide a .php endpoint.
	function decodedPath(url) {
		var path = url.split(/[?#]/)[0];
		try { return decodeURIComponent(path); } catch (e) { return path; }
	}

	function cleanNode(node) {
		// Comments can hide conditional markup; drop them.
		if (node.nodeType === 8) { node.remove(); return; }
		if (node.nodeType !== 1) { return; }

		var tag = node.tagName.toLowerCase();

		if (DROP_WITH_CONTENT[tag]) { node.remove(); return; }

		// Clean descendants before possibly unwrapping this element. Cleaning
		// only the original top-level list lets a forbidden wrapper smuggle an
		// unvisited child into the result, for example:
		//
		//     <section><img src=x onerror=alert(1)></section>
		//
		// Once section is removed, that img is a top-level node and would retain
		// its event handler. Recursing first ensures every surviving descendant
		// has passed the attribute allowlist.
		Array.prototype.slice.call(node.childNodes).forEach(cleanNode);

		if (!ALLOWED_TAGS[tag]) {
			// Keep the text, lose the element -- so stripping <script> does not
			// silently delete a paragraph someone wrote around it.
			var parent = node.parentNode;
			while (node.firstChild) { parent.insertBefore(node.firstChild, node); }
			parent.removeChild(node);
			return;
		}

		var permitted = ALLOWED_ATTRS[tag] || {};
		var global = ALLOWED_ATTRS['*'];

		// Copy first: removing while iterating skips entries.
		Array.prototype.slice.call(node.attributes).forEach(function(attr) {
			var name = attr.name.toLowerCase();
			var value = attr.value;

			if (!permitted[name] && !global[name]) { node.removeAttribute(attr.name); return; }

			if (name === 'href' || name === 'src') {
				var v = value.trim();
				if (!(name === 'src' ? SAFE_IMG_URL : SAFE_URL).test(v) || (name === 'href' ? /\.php/i : /\.php$/i).test(decodedPath(v))) { node.removeAttribute(attr.name); return; }
			}
			if (name === 'style') {
				var safe = cleanStyle(value);
				if (safe === null) { node.removeAttribute(attr.name); return; }
				node.setAttribute('style', safe);
			}
			if ((tag === 'table' || tag === 'td' || tag === 'th') && name !== 'colspan' && name !== 'rowspan' && !NUMERIC_ATTR.test(value.trim())) {
				node.removeAttribute(attr.name); return;
			}
			if (tag === 'font' && name === 'size' && !/^[1-7]$/.test(value.trim())) {
				node.removeAttribute(attr.name);
			}
		});

		// A link that opens a new tab must not hand the opener over with it.
		if (tag === 'a' && node.getAttribute('target')) {
			node.setAttribute('rel', 'noopener noreferrer');
		}

	}

	return function sanitiseHtml(html) {
		if (html == null) { return ''; }

		// An inert document: images do not load and scripts do not run while
		// the tree is being inspected.
		var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');

		Array.prototype.slice.call(doc.body.childNodes).forEach(cleanNode);
		return doc.body.innerHTML;
	};
})();

