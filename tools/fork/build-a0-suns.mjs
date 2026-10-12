// Fork-owned (environment-tags): builds public/environment-data/a0-suns.json, the static list of k-space systems whose
// star is "Sun A0 (Blue Small)" (typeID 3801), from CCP's public Static Data Export (SDE, JSON Lines). Run by hand when
// CCP publishes a new SDE (stars don't change); never at runtime:
//   1. download https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip and unzip
//      mapStars.jsonl and mapSolarSystems.jsonl into a directory
//   2. node tools/fork/build-a0-suns.mjs <dir> <sdeBuild> <YYYY-MM-DD> > public/environment-data/a0-suns.json
// Output: {v, sde, date, type, systems: [solarSystemID, ...]} sorted. Wormhole systems (regionID >= 11000000; 78 of them
// also have star type 3801 but show their own effects) and the one captured A0 variant (typeID 78350) are left out.
// Ice belts are not in the SDE: every mapAsteroidBelts.jsonl row is typeID 15 (ordinary belt); ice fields are
// anomalies that spawn at run time, so there is nothing static to tag.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, sde, date] = process.argv.slice(2);
if (!dir || !sde || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
	console.error('usage: node build-a0-suns.mjs <dir with mapStars.jsonl and mapSolarSystems.jsonl> <SDE build number> <YYYY-MM-DD>');
	process.exit(1);
}
const A0_BLUE_SMALL = 3801;
const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const region = new Map(lines('mapSolarSystems.jsonl').map((s) => [s._key, s.regionID]));
const systems = lines('mapStars.jsonl')
	.filter((s) => s.typeID === A0_BLUE_SMALL && region.has(s.solarSystemID) && region.get(s.solarSystemID) < 11000000)
	.map((s) => s.solarSystemID)
	.sort((a, b) => a - b);
console.error('A0 (Blue Small) k-space systems: ' + systems.length);
console.log(JSON.stringify({ v: 1, sde: String(sde), date, type: A0_BLUE_SMALL, systems }));
