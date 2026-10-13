// Allow include of non-module script - https://stackoverflow.com/questions/5797852/
var fs = require("fs");

function read(f) {
  return fs.readFileSync(f).toString()
	.replace(/^var /, '')
	.replace(/^const /, '')
	.replace(/\nconst /, '');
}
// The game data (appData, plus the generic system types the app adds to it) is loaded once and shared, so
// every test file sees the same full appData whatever order the runner loads the files in.
let gameData;
function include(f) {
	if(f === 'public/js/combine') {
		if(!gameData) { evalFile(f); evalFile('app/js/tripwire/genericSystemTypes'); gameData = global.appData; }
		global.appData = gameData;
		return;
	}
	return evalFile(f);
}
function evalFile(f) {
	return eval.apply(global, [
		read(f + '.js') + '\n//# sourceURL=' + f
	]);
}
function loadJSON(f) {
	return JSON.parse(fs.readFileSync(f + '.json').toString());
}
function fake$(prop, fn) {
	if(!global.$) { global.$ = () => global.$; }	// this construction allows $.xyz and $('...').xyz to resolve
	if(!global.$[prop]) { global.$[prop] = fn; }
}

/** Fake out a call to $.ajax with static data from the given source.
Can call with no arguments to set up the $.ajax infrastructure.
The action in done() will be dispatched synchronously to simplify testing */
function fakeAjax(url, responseFile) {
	let responseData = null; 
	if(url || responseFile) {
		console.debug('faking URL ' + url);
		responseData = fs.readFileSync(responseFile).toString();
		if(responseFile.endsWith('.json')) { responseData = JSON.parse(responseData); }
		if(!responseData) { throw "couldn't read " + responseFile; }
		fakeAjaxRequestMap[url] = responseData;
	}
	
	// Create a fake $.ajax that will look up previously faked requests
	fake$();
	if(!$.ajax) {
		const requestBuilder = {};
		let fakeRequestUrl;
		requestBuilder.done = f => {
				if(fakeAjaxRequestMap[fakeRequestUrl] !== undefined) {
					f(fakeAjaxRequestMap[fakeRequestUrl]);
				}
				return requestBuilder;
			};
		requestBuilder.fail = f => {
			if(fakeAjaxRequestMap[fakeRequestUrl] === undefined) {
				f(null, 404, 'Unfaked request ' + fakeRequestUrl);
			}
		};
		$.ajax = data => {
			fakeRequestUrl = data.url;
			console.debug('intercepting URL ' + data.url);
			return requestBuilder;
		}
	}
}
const fakeAjaxRequestMap = {};

module.exports = { include, fakeAjax, loadJSON, fake$ };
