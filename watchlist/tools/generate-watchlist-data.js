// Fork-owned: regenerates watchlist/data.json, the static data the server-side watchlist matcher uses (the Discord
// "Watchlist match" notification, watchlist/watchlist.inc.php): per system the fields the browser's matcher reads
// from appData (name, security, region, constellation, faction, wormhole class, effect, statics), wormhole types
// (where they lead, max jump mass) and region names. Source: appData in public/js/combine.js, the same data the
// browser matches with. Run after upstream updates combine.js:
//   docker compose -f docker-compose.dev.yml exec -T assets node watchlist/tools/generate-watchlist-data.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/combine.js'), 'utf8') + '\nthis.appData = appData;', context);
const appData = context.appData;

const systems = {};
Object.keys(appData.systems).map(Number).filter((id) => Number.isInteger(id) && id >= 30000000 && id < 33000000)
	.sort((a, b) => a - b).forEach((id) => {
		const s = appData.systems[id];
		const out = { name: s.name, security: Number(Number(s.security).toFixed(3)), regionID: Number(s.regionID) || 0 };
		if (s.constellationID) { out.constellationID = Number(s.constellationID); }
		if (s.factionID) { out.factionID = Number(s.factionID); }
		const cls = Array.isArray(s.class) ? s.class[0] : s.class;
		if (cls) { out.class = Number(cls); }
		if (s.effect) { out.effect = s.effect; }
		if (Array.isArray(s.statics) && s.statics.length) { out.statics = s.statics.slice(); }
		systems[id] = out;
	});
const wormholes = {};
Object.keys(appData.wormholes).sort().forEach((type) => {
	const w = appData.wormholes[type];
	wormholes[type] = { leadsTo: w.leadsTo, jump: Number(w.jump) || 0 };
});
const regions = {};
Object.keys(appData.regions || {}).map(Number).sort((a, b) => a - b).forEach((id) => { regions[id] = appData.regions[id].name; });

fs.writeFileSync(path.join(root, 'watchlist/data.json'), JSON.stringify({ systems: systems, wormholes: wormholes, regions: regions }) + '\n');
console.log('watchlist/data.json: ' + Object.keys(systems).length + ' systems, ' + Object.keys(wormholes).length + ' wormhole types, '
	+ Object.keys(regions).length + ' regions');
