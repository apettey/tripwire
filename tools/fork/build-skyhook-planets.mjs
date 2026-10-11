// Fork-owned (skyhooks-planet-value): builds public/skyhooks-data/planets.json, the static list of planets that can
// have a skyhook yielding reagents, from CCP's public Static Data Export (SDE, JSON Lines). Run by hand when CCP
// publishes a new SDE (planets and their yields rarely change); never at runtime:
//   1. download https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip and unzip
//      planetResources.jsonl and mapPlanets.jsonl into a directory
//   2. node tools/fork/build-skyhook-planets.mjs <dir> <magmaticGasPrice> <superionicIcePrice> > public/skyhooks-data/planets.json
//      (prices: ESI GET /markets/prices average_price for types 81143 / 81144, just a rough ISK per unit)
// planetResources: per planet, power or workforce, or a `reagent` {type_id, amount_per_cycle, cycle_period 3600 s,
// secured_capacity, unsecured_capacity}. Reagent type 81143 = Magmatic Gas (lava planets, planet type 2015),
// 81144 = Superionic Ice (ice planets, type 12). Output: {v, date, reagents, planets: {planetID: [kind, perHour, index]}}
// kind 1 = lava, 2 = ice; index = celestialIndex (the roman numeral in the planet's name).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, gasPrice, icePrice] = process.argv.slice(2);
if (!dir || !(Number(gasPrice) > 0) || !(Number(icePrice) > 0)) {
	console.error('usage: node build-skyhook-planets.mjs <dir with the two .jsonl files> <Magmatic Gas ISK> <Superionic Ice ISK>');
	process.exit(1);
}
const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const index = new Map(lines('mapPlanets.jsonl').map((p) => [p._key, p.celestialIndex]));
const KIND = { 81143: 1, 81144: 2 };
const planets = {};
for (const row of lines('planetResources.jsonl')) {
	const r = row.reagent;
	if (!r || !KIND[r.type_id] || r.cycle_period !== 3600 || !index.has(row._key)) continue;
	planets[row._key] = [KIND[r.type_id], r.amount_per_cycle, index.get(row._key)];
}
const out = {
	v: 1,
	date: new Date().toISOString().slice(0, 10),
	reagents: { 1: { name: 'Magmatic Gas', typeID: 81143, price: Number(gasPrice) }, 2: { name: 'Superionic Ice', typeID: 81144, price: Number(icePrice) } },
	planets,
};
console.log(JSON.stringify(out));
