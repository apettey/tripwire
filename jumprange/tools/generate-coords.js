#!/usr/bin/env node
// Fork-owned: builds the Jump planner's static data from CCP's Static Data Export (SDE, JSON Lines edition).
//
//   node jumprange/tools/generate-coords.js <sde-dir> [out-dir] [--zip <the downloaded SDE zip>]
//
// <sde-dir> holds the unzipped SDE files this reads: _sde.jsonl, mapSolarSystems.jsonl, mapStargates.jsonl,
// types.jsonl, groups.jsonl, typeDogma.jsonl, dogmaEffects.jsonl, typeBonus.jsonl, npcStations.jsonl (download: https://developers.eveonline.com/static-data, the
// "JSON Lines" zip). [out-dir] defaults to public/jumprange. --zip records the zip's file name and SHA-256 in meta. Writes:
//
// systems.json  Every k-space solar system that can be reached by stargates from Jita, plus Pochven (cut off
//               from the gate network, but you can jump out of it) and Zarzakh. Positions in light-years,
//               multiplied by 1000 and rounded (0.001 LY), columnar and delta-encoded by system ID order:
//               {meta, ids: [first, +d, +d, ...], x: [first, +d, ...], y: [...], z: [...]}
//               Decode: running sums. Systems that are not reachable at all (the Jove regions, which have no
//               gates in or out) are left out: they can be neither a jump origin nor a target.
//               Axes are the SDE's: x east, y up, z north (a top-down map draws x right and z up).
// ships.json    Every published ship (category 6) with a jump drive (dogma attribute 867 jumpDriveRange):
//               {meta, ships: [{typeID, name, groupID, group, baseLy, covert, fuelTypeID, fuelName, fuelPerLy,
//               fuelBonuses, fuelRole}]}. covert: the hull can jump to a covert cynosural field, i.e. the Black
//               Ops group (898); no dogma attribute says this. Jump fuel (fuelTypeID / fuelName / fuelPerLy are
//               left out when the SDE has no value): fuelTypeID / fuelName = attribute 866 jumpDriveConsumptionType
//               and that type's English name (an isotope); fuelPerLy = attribute 868 jumpDriveConsumptionAmount,
//               units per LY before skills; fuelBonuses = [{skillID, skill, perLevel}] hull skill bonuses to
//               attribute 868, perLevel a fraction (0.1 = 10% less fuel per skill level), found through the dogma
//               effects that modify 868 (the percentage is the hull's modifying attribute, e.g. 1312 on Jump
//               Freighters; the skill comes from the hull's trait line "reduction in jump fuel requirement", whose
//               percentage must match); fuelRole = fixed role bonus as a fraction (a role trait about jump fuel;
//               0 when none). meta.fuelSkill is the skill every hull can train: the one whose dogma effect
//               modifies 868 (Jump Fuel Conservation, 21610): {skillID, skill, perLevel}.
//
// stations.json The systems that have at least one NPC station (npcStations.jsonl, solarSystemID), among the systems of
//               systems.json: {meta, systems: [first system ID, +d, +d, ...] (sorted), counts: [stations in each]}.
//               Used by the Jump planner to prefer midpoints a ship can dock at.
//
// The output only changes when the SDE does, so re-run it after a game update and commit both files.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LY_M = 9.4607e15;			// metres per light-year, as EVE uses it
const SCALE = 1000;				// stored unit: 0.001 LY
const JITA = 30000142;
const POCHVEN_REGION = 10000070;
const ZARZAKH = 30100000;
const SHIP_CATEGORY = 6;
const ATTR_JUMP_RANGE = 867;
const BLACK_OPS_GROUP = 898;
const ATTR_FUEL_TYPE = 866;			// jumpDriveConsumptionType
const ATTR_FUEL_PER_LY = 868;		// jumpDriveConsumptionAmount
const ATTR_SKILL_TRAINING = 275;	// trainingTimeMultiplier: set on skills only

async function eachLine(dir, file, fn) {
	const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)), crlfDelay: Infinity });
	for await (const line of rl) {
		if (line.trim()) { fn(JSON.parse(line)); }
	}
}

function deltas(values) {
	return values.map((v, i) => (i ? v - values[i - 1] : v));
}

function sha256(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
	});
}

async function main() {
	const args = process.argv.slice(2);
	const zipAt = args.indexOf('--zip');
	const zip = zipAt >= 0 ? args.splice(zipAt, 2)[1] : null;
	if (zipAt >= 0 && !zip) { console.error('--zip needs the SDE zip file'); process.exit(2); }
	const sde = args[0];
	const out = args[1] || path.join(__dirname, '..', '..', 'public', 'jumprange');
	if (!sde) { console.error('usage: generate-coords.js <sde-dir> [out-dir] [--zip <sde-zip>]'); process.exit(2); }

	const zipInfo = zip ? { sdeZip: path.basename(zip), sdeZipSha256: await sha256(zip) } : {};
	let build = null;
	await eachLine(sde, '_sde.jsonl', (r) => { if (r._key === 'sde') { build = r; } });
	if (!build) { throw new Error('_sde.jsonl has no build number'); }

	// ---- Systems ----
	const systems = {};
	await eachLine(sde, 'mapSolarSystems.jsonl', (s) => {
		if (s._key >= 30000000 && s._key < 31000000 || s._key === ZARZAKH) {
			systems[s._key] = { id: s._key, regionID: s.regionID, pos: s.position, name: s.name && s.name.en };
		}
	});
	const gates = {};
	await eachLine(sde, 'mapStargates.jsonl', (g) => {
		const from = g.solarSystemID, to = g.destination && g.destination.solarSystemID;
		if (!systems[from] || !systems[to]) { return; }
		(gates[from] = gates[from] || []).push(to);
	});
	// Reachable by gates from Jita
	const reached = { [JITA]: true };
	const queue = [JITA];
	for (let i = 0; i < queue.length; i++) {
		(gates[queue[i]] || []).forEach((n) => { if (!reached[n]) { reached[n] = true; queue.push(n); } });
	}
	const kept = Object.values(systems).filter((s) => reached[s.id] || s.regionID === POCHVEN_REGION || s.id === ZARZAKH)
		.sort((a, b) => a.id - b.id);
	const left = Object.values(systems).filter((s) => !kept.includes(s));
	const leftRegions = {};
	left.forEach((s) => { leftRegions[s.regionID] = (leftRegions[s.regionID] || 0) + 1; });

	const ly = (m) => Math.round(m / LY_M * SCALE);
	const ids = kept.map((s) => s.id);
	const data = {
		meta: {
			version: build.buildNumber,
			source: 'EVE Online Static Data Export (developers.eveonline.com), mapSolarSystems + mapStargates',
			sdeBuild: build.buildNumber,
			sdeReleaseDate: build.releaseDate,
			...zipInfo,
			unit: 'light-years x ' + SCALE + ' (LY = ' + LY_M + ' m), rounded',
			axes: 'x east, y up, z north (SDE axes); top-down map: x right, z up',
			encoding: 'ids, x, y, z: first value, then differences to the previous entry (decode with running sums)',
			count: kept.length,
			left_out: 'k-space systems not reachable by stargates from Jita, except Pochven and Zarzakh: regions '
				+ Object.keys(leftRegions).map((r) => r + ' (' + leftRegions[r] + ')').join(', ')
		},
		ids: deltas(ids),
		x: deltas(kept.map((s) => ly(s.pos.x))),
		y: deltas(kept.map((s) => ly(s.pos.y))),
		z: deltas(kept.map((s) => ly(s.pos.z)))
	};

	// ---- Ships ----
	const range = {};
	const dogma = {};
	await eachLine(sde, 'typeDogma.jsonl', (t) => {
		const attrs = {};
		(t.dogmaAttributes || []).forEach((a) => { attrs[a.attributeID] = a.value; });
		if (attrs[ATTR_JUMP_RANGE] > 0) { range[t._key] = attrs[ATTR_JUMP_RANGE]; }
		// Jump drive hulls (their fuel) and skills (the fuel skill)
		if (attrs[ATTR_JUMP_RANGE] > 0 || attrs[ATTR_SKILL_TRAINING] !== undefined) {
			dogma[t._key] = { attrs, effects: (t.dogmaEffects || []).map((e) => e.effectID) };
		}
	});
	// Dogma effects that change the fuel per light-year (attribute 868) of the item they are on: effectID -> the
	// attribute holding the percentage (operation 6 = post-percent: -10 means 10% less)
	const fuelEffect = {};
	await eachLine(sde, 'dogmaEffects.jsonl', (e) => {
		(e.modifierInfo || []).forEach((m) => {
			if (m.modifiedAttributeID === ATTR_FUEL_PER_LY && m.domain === 'shipID' && m.operation === 6) { fuelEffect[e._key] = m.modifyingAttributeID; }
		});
	});
	// Trait lines per hull (typeBonus): skill bonuses by skill id, and role bonuses
	const traits = {};
	await eachLine(sde, 'typeBonus.jsonl', (t) => { traits[t._key] = t; });
	const plain = (b) => String((b.bonusText && b.bonusText.en) || '').replace(/<[^>]+>/g, '');
	const isJumpFuelText = (b) => /jump fuel/i.test(plain(b));
	const groups = {};
	await eachLine(sde, 'groups.jsonl', (g) => { groups[g._key] = g; });
	const ships = [];
	const names = {};
	const skills = {};		// published skills with a fuel effect: {skillID: {skillID, skill, perLevel}}
	await eachLine(sde, 'types.jsonl', (t) => {
		names[t._key] = t.name && t.name.en;
		const d = dogma[t._key];
		if (d && d.attrs[ATTR_SKILL_TRAINING] !== undefined && t.published) {
			d.effects.forEach((id) => {
				// A skill's fuel effect reads the attribute on the skill itself (Jump Fuel Conservation: -10 per level)
				if (fuelEffect[id] !== undefined && d.attrs[fuelEffect[id]] !== undefined) {
					skills[t._key] = { skillID: t._key, skill: t.name.en, perLevel: Math.round(-d.attrs[fuelEffect[id]]) / 100 };
				}
			});
		}
		const g = groups[t.groupID];
		if (!range[t._key] || !t.published || !g || g.categoryID !== SHIP_CATEGORY) { return; }
		ships.push({ typeID: t._key, name: t.name.en, groupID: t.groupID, group: g.name.en, baseLy: range[t._key], covert: t.groupID === BLACK_OPS_GROUP });
	});
	const fuelSkills = Object.values(skills);
	if (fuelSkills.length !== 1) { throw new Error('expected one skill that reduces jump fuel, found ' + fuelSkills.length); }
	ships.forEach((s) => {
		const d = dogma[s.typeID];
		if (d.attrs[ATTR_FUEL_TYPE] > 0 && d.attrs[ATTR_FUEL_PER_LY] > 0) {
			s.fuelTypeID = d.attrs[ATTR_FUEL_TYPE];
			s.fuelName = names[s.fuelTypeID];
			s.fuelPerLy = d.attrs[ATTR_FUEL_PER_LY];
		}
		// Hull skill bonuses: an effect on the hull that modifies 868 through one of its attributes (-10 = 10% per level)
		s.fuelBonuses = [];
		d.effects.forEach((id) => {
			const percent = fuelEffect[id] !== undefined ? -d.attrs[fuelEffect[id]] : undefined;
			if (!(percent > 0)) { return; }
			const t = traits[s.typeID] || {};
			const lines = [];
			(t.types || []).forEach((g) => g._value.forEach((b) => { if (isJumpFuelText(b) && b.bonus === percent) { lines.push({ skillID: g._key, skill: names[g._key] }); } }));
			if (lines.length !== 1) { throw new Error(s.name + ': a jump fuel bonus of ' + percent + '% but ' + lines.length + ' matching trait lines'); }
			s.fuelBonuses.push({ skillID: lines[0].skillID, skill: lines[0].skill, perLevel: percent / 100 });
		});
		// A role trait about jump fuel (none today) has no attribute to read: take its percentage
		s.fuelRole = ((traits[s.typeID] || {}).roleBonuses || []).filter(isJumpFuelText).reduce((sum, b) => sum + (b.bonus || 0) / 100, 0);
	});
	ships.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
	const shipData = {
		meta: {
			version: build.buildNumber,
			source: 'EVE Online Static Data Export (developers.eveonline.com), types + groups + typeDogma attributes 867 (jumpDriveRange), 866 (jumpDriveConsumptionType), 868 (jumpDriveConsumptionAmount) + dogmaEffects that modify 868 + typeBonus traits',
			sdeBuild: build.buildNumber,
			sdeReleaseDate: build.releaseDate,
			...zipInfo,
			covert: 'true for the Black Ops group (898): the only hulls that can jump to a covert cynosural field',
			fuel: 'fuelTypeID/fuelName: isotope (attribute 866); fuelPerLy: units per LY before skills (attribute 868); '
				+ 'fuelBonuses: hull skill bonuses [{skillID, skill, perLevel}] (fraction per level); fuelRole: fixed role bonus (fraction); '
				+ 'per jump: ceil(fuelPerLy x LY x (1 - perLevel x level) for the fuel skill and each hull skill x (1 - fuelRole))',
			fuelSkill: fuelSkills[0]
		},
		ships: ships
	};

	// ---- NPC stations ----
	const stationCount = {};
	await eachLine(sde, 'npcStations.jsonl', (st) => { stationCount[st.solarSystemID] = (stationCount[st.solarSystemID] || 0) + 1; });
	const stationIds = ids.filter((id) => stationCount[id] > 0);
	const stationData = {
		meta: {
			version: build.buildNumber,
			source: 'EVE Online Static Data Export (developers.eveonline.com), npcStations (solarSystemID)',
			sdeBuild: build.buildNumber,
			sdeReleaseDate: build.releaseDate,
			...zipInfo,
			encoding: 'systems: system IDs of systems.json with at least one NPC station, first value, then differences to the previous entry; counts: NPC stations in each, same order',
			count: stationIds.length
		},
		systems: deltas(stationIds),
		counts: stationIds.map((id) => stationCount[id])
	};

	fs.mkdirSync(out, { recursive: true });
	fs.writeFileSync(path.join(out, 'stations.json'), JSON.stringify(stationData) + '\n');
	fs.writeFileSync(path.join(out, 'systems.json'), JSON.stringify(data) + '\n');
	fs.writeFileSync(path.join(out, 'ships.json'), JSON.stringify(shipData, null, '\t') + '\n');
	console.log('systems:', kept.length, 'kept,', left.length, 'left out', JSON.stringify(leftRegions));
	console.log('ships:', ships.length);
	console.log('stations.json:', stationIds.length, 'systems with an NPC station,', Object.values(stationCount).reduce((a, b) => a + b, 0), 'stations in total');
	console.log('systems.json', fs.statSync(path.join(out, 'systems.json')).size, 'bytes');
}

main().catch((e) => { console.error(e); process.exit(1); });
