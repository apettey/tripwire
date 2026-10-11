// Fork-owned test helper: a very small DOM (elements, text nodes, fragments) with an HTML serialiser, for code that
// builds or rewrites DOM nodes with createElement / createTextNode / setAttribute / textContent only
// (app/js/fork/smart-notes.js). Not a browser: no parser, no selectors, no events.

class Node {
	constructor(doc) {
		this.ownerDocument = doc;
		this.parentNode = null;
		this.childNodes = [];
	}
	get firstChild() { return this.childNodes[0] || null; }
	get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
	_take(child) {
		if (child.nodeType === 11) { return child.childNodes.slice(); }
		if (child.parentNode) { child.parentNode.removeChild(child); }
		return [child];
	}
	appendChild(child) {
		this._take(child).forEach(c => { if (child.nodeType === 11) { child.childNodes = []; } c.parentNode = this; this.childNodes.push(c); });
		if (child.nodeType === 11) { child.childNodes = []; }
		return child;
	}
	insertBefore(child, ref) {
		if (!ref) { return this.appendChild(child); }
		const nodes = this._take(child);
		if (child.nodeType === 11) { child.childNodes = []; }
		const at = this.childNodes.indexOf(ref);
		if (at < 0) { throw new Error('insertBefore: not a child'); }
		nodes.forEach(c => { c.parentNode = this; });
		this.childNodes.splice(at, 0, ...nodes);
		return child;
	}
	removeChild(child) {
		const at = this.childNodes.indexOf(child);
		if (at < 0) { throw new Error('removeChild: not a child'); }
		this.childNodes.splice(at, 1);
		child.parentNode = null;
		return child;
	}
	replaceChild(child, old) {
		this.insertBefore(child, old);
		return this.removeChild(old);
	}
	contains(node) {
		for (let n = node; n; n = n.parentNode) { if (n === this) { return true; } }
		return false;
	}
	get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
	set textContent(value) {
		this.childNodes.forEach(c => { c.parentNode = null; });
		this.childNodes = [];
		if (value !== '' && value !== null && value !== undefined) { this.appendChild(this.ownerDocument.createTextNode(String(value))); }
	}
}

class Text extends Node {
	constructor(doc, value) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = String(value); }
	get textContent() { return this.nodeValue; }
	set textContent(value) { this.nodeValue = String(value); }
	cloneNode() { return new Text(this.ownerDocument, this.nodeValue); }
	get outerHTML() { return escapeText(this.nodeValue); }
}

class Fragment extends Node {
	constructor(doc) { super(doc); this.nodeType = 11; this.nodeName = '#document-fragment'; }
}

class Element extends Node {
	constructor(doc, tag) {
		super(doc);
		this.nodeType = 1;
		this.nodeName = this.tagName = String(tag).toUpperCase();
		this.attributes = {};
		const el = this;
		this.classList = {
			contains: c => (el.getAttribute('class') || '').split(/\s+/).indexOf(c) >= 0,
			add: c => { if (!el.classList.contains(c)) { el.setAttribute('class', ((el.getAttribute('class') || '') + ' ' + c).trim()); } }
		};
	}
	setAttribute(name, value) { this.attributes[String(name).toLowerCase()] = String(value); }
	getAttribute(name) { const k = String(name).toLowerCase(); return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
	hasAttribute(name) { return this.getAttribute(name) !== null; }
	removeAttribute(name) { delete this.attributes[String(name).toLowerCase()]; }
	get id() { return this.getAttribute('id') || ''; }
	closest(cls) {
		const want = cls.replace(/^\./, '');
		for (let n = this; n && n.nodeType === 1; n = n.parentNode) { if (n.classList.contains(want)) { return n; } }
		return null;
	}
	cloneNode(deep) {
		const copy = new Element(this.ownerDocument, this.tagName);
		copy.attributes = Object.assign({}, this.attributes);
		if (deep) { this.childNodes.forEach(c => copy.appendChild(c.cloneNode(true))); }
		return copy;
	}
	get innerHTML() { return this.childNodes.map(c => c.outerHTML).join(''); }
	get outerHTML() {
		const tag = this.tagName.toLowerCase();
		const attrs = Object.keys(this.attributes).map(k => ' ' + k + '="' + escapeAttr(this.attributes[k]) + '"').join('');
		return '<' + tag + attrs + '>' + this.innerHTML + (/^(img|br)$/.test(tag) ? '' : '</' + tag + '>');
	}
}

function escapeText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

function createDocument() {
	const doc = {
		createElement: tag => new Element(doc, tag),
		createTextNode: value => new Text(doc, value),
		createDocumentFragment: () => new Fragment(doc)
	};
	return doc;
}

/** Build a tree: h(doc, 'p', {class: 'x'}, ['text', h(doc, 'a', {href: '...'}, ['link'])]) */
function h(doc, tag, attrs, children) {
	const el = doc.createElement(tag);
	Object.keys(attrs || {}).forEach(k => el.setAttribute(k, attrs[k]));
	(children || []).forEach(c => el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c));
	return el;
}

module.exports = { createDocument, h };
