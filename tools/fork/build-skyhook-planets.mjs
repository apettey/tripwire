// Fork-owned (skyhooks-planet-value): builds public/skyhooks-data/planets.json, the static list of planets that can
// have a skyhook yielding reagents, from CCP's public Static Data Export (SDE, JSON Lines). Run by hand when CCP
// publishes a new SDE (planets and their yields rarely change); never at runtime:
//   1. download https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip and unzip
//      planetResources.jsonl and mapPlanets.jsonl into a directory (the zip's real name has the build number, e.g.
//      eve-online-static-data-3586130-jsonl.zip)
//   2. node tools/fork/build-skyhook-planets.mjs <dir> <magmaticGasPrice> <superionicIcePrice> <sdeBuild> <YYYY-MM-DD> \
//        > public/skyhooks-data/planets.json
//      (prices: ESI GET /markets/prices average_price for types 81143 / 81144, just a rough ISK per unit)
// planetResources: per planet, power or workforce, or a `reagent` {type_id, amount_per_cycle, cycle_period 3600 s,
// secured_capacity, unsecured_capacity}. Reagent type 81143 = Magmatic Gas (lava planets, planet type 2015),
// 81144 = Superionic Ice (ice planets, type 12). Output: {v, sde, date, reagents, planets: {planetID: [kind, perHour, index]}}
// kind 1 = lava, 2 = ice; index = celestialIndex (the roman numeral in the planet's name). Counts of rows left out
// go to stderr.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, gasPrice, icePrice, sde, date] = process.argv.slice(2);
if (!dir || !(Number(gasPrice) > 0) || !(Number(icePrice) > 0) || !sde || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
	console.error('usage: node build-skyhook-planets.mjs <dir with the two .jsonl files> <Magmatic Gas ISK> <Superionic Ice ISK> <SDE build number> <YYYY-MM-DD>');
	process.exit(1);
}
const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const index = new Map(lines('mapPlanets.jsonl').map((p) => [p._key, p.celestialIndex]));
const KIND = { 81143: 1, 81144: 2 };
const planets = {};
const skipped = { noReagent: 0, unknownReagentType: 0, badCycle: 0, notInMapPlanets: 0 };
for (const row of lines('planetResources.jsonl')) {
	const r = row.reagent;
	if (!r) { skipped.noReagent++; continue; }
	if (!KIND[r.type_id]) { skipped.unknownReagentType++; continue; }
	if (r.cycle_period !== 3600) { skipped.badCycle++; continue; }
	if (!index.has(row._key)) { skipped.notInMapPlanets++; continue; }
	planets[row._key] = [KIND[r.type_id], r.amount_per_cycle, index.get(row._key)];
}
console.error('planets written: ' + Object.keys(planets).length + '; rows skipped: ' + JSON.stringify(skipped) + ' (noReagent = power / workforce planets, expected)');
const out = {
	v: 1,
	sde: String(sde),
	date,
	reagents: { 1: { name: 'Magmatic Gas', typeID: 81143, price: Number(gasPrice) }, 2: { name: 'Superionic Ice', typeID: 81144, price: Number(icePrice) } },
	planets,
};
console.log(JSON.stringify(out));
