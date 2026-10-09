// Simple fake for DOM manipulation. Should probably use jsdom or something
const document = {
	setup: () => {
		document.elementsById = {}; // Add element objects here before looking up with getElementById
		if(!global.document) { global.document = document; }
	},
	getElementById: id => document.elementsById[id],
	createElement: tag => new Element(tag),	
};

class Element {
	constructor(tag) {
		this.tag = tag.toUpperCase();
		this.children = [];
		this.parent = null;
	}
	
	appendChild(child) {
		if(child.parent) { child.parent.children = child.parent.children.filter(c => c !== child); }
		this.children.filter(c => c !== child);
		this.children.push(child);
		child.parent = this;
	}
	
	addEventListener(eventType, handler) { }
}

module.exports = { document };