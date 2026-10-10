#!/usr/bin/env node
// Fork tool: copy tools/wormholes.json and tools/mass.json into public/js/combine.js without the EVE SDE database.
// Upstream's tools/json_builder.php rebuilds the whole file from the SDE; this only replaces the "wormholes"
// and "mass" sections, written the way PHP's json_encode(..., JSON_PRETTY_PRINT) writes them (4-space indent,
// escaped "/" and non-ASCII, same line ends as the file), so the diff shows only the changed values.
// Usage (repo root): node tools/fork/splice-combine.js [--check]   (--check: exit 1 if combine.js is out of date)
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const combinePath = path.join(root, 'public', 'js', 'combine.js');

// JSON.parse would move integer-like keys (ship type IDs) into numeric order; PHP keeps file order, so tag them
const KEY_TAG = '~k~';
function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8').replace(/"(\d+)"(\s*):/g, '"' + KEY_TAG + '$1"$2:'));
}

function escapeNonAscii(text) {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		out += code > 127 ? '\\u' + code.toString(16).padStart(4, '0') : text[i];
	}
	return out;
}

function phpJson(value) {
	return escapeNonAscii(JSON.stringify(value, null, 4).split('"' + KEY_TAG).join('"').replace(/\//g, '\\/'));
}

function section(name, value, eol) {
	// a top-level key of appData: indented one level
	return ('    "' + name + '": ' + phpJson(value).split('\n').join('\n    ')).split('\n').join(eol);
}

function splice(text, name, value) {
	const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';	// LF in git, CRLF in a Windows checkout with autocrlf
	const start = text.indexOf(eol + '    "' + name + '": {' + eol);
	if (start < 0) { throw new Error('section "' + name + '" not found in combine.js'); }
	const close = text.indexOf(eol + '    }', start + eol.length);
	if (close < 0) { throw new Error('end of section "' + name + '" not found'); }
	return text.slice(0, start + eol.length) + section(name, value, eol) + text.slice(close + (eol + '    }').length);
}

const before = fs.readFileSync(combinePath, 'latin1');
let after = before;
after = splice(after, 'wormholes', readJson(path.join(root, 'tools', 'wormholes.json')));
after = splice(after, 'mass', readJson(path.join(root, 'tools', 'mass.json')));

if (process.argv.indexOf('--check') >= 0) {
	if (after !== before) { console.error('public/js/combine.js is out of date: run node tools/fork/splice-combine.js'); process.exit(1); }
	console.log('public/js/combine.js is up to date');
} else if (after === before) {
	console.log('public/js/combine.js unchanged');
} else {
	fs.writeFileSync(combinePath, after, 'latin1');
	console.log('public/js/combine.js updated');
}
