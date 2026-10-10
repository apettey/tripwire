// Fork-owned: regenerates public/intel/types.json, the static type data the d-scan summaries use (type ID -> name
// and group, group -> name, category and ship class). One-off read of ESI's public, unauthenticated universe
// endpoints (no token); Tripwire itself never calls ESI for this at runtime. Run with Node 18+ after a game update
// that adds ships or structures:
//   node intel/tools/generate-types.js
'use strict';
const fs = require('fs');
const path = require('path');

const ESI = 'https://esi.evetech.net/latest';
const USER_AGENT = 'Tripwire fork intel type generator (one-off static data build)';

// Categories whose types can show up on d-scan and are worth naming
const CATEGORIES = {
	6: 'ship',
	18: 'drone',
	87: 'fighter',
	22: 'deployable',
	23: 'starbase',
	65: 'structure',
	40: 'sovereignty',
	46: 'orbital',
	3: 'station'
};
// Further groups by ID: celestial (category 2) groups worth naming (the rest of the category is thousands of beacons
// and effects), containers, active cynosural fields, the POS force field and the customs office group (several of
// these are unpublished in ESI but do show up on d-scan)
const EXTRA_GROUPS = {
	6: ['Sun', 'celestial'], 7: ['Planet', 'celestial'], 8: ['Moon', 'celestial'], 9: ['Asteroid Belt', 'celestial'],
	10: ['Stargate', 'celestial'], 186: ['Wreck', 'celestial'], 988: ['Wormhole', 'celestial'],
	12: ['Cargo Container', 'container'], 340: ['Secure Cargo Container', 'container'],
	448: ['Audit Log Secure Container', 'container'], 649: ['Freight Container', 'container'],
	2020: ['Cynosural Field', 'cyno'], 897: ['Covert Cynosural Field', 'cyno'],
	411: ['Force Field', 'starbase'], 1025: ['Customs Office', 'orbital']
};
// Cynosural field generators (normal, covert, industrial): the hulls that can fit one come from their dogma
// attributes canFitShipGroupNN / canFitShipTypeNN
const CYNO_MODULES = [21096, 28646, 52694];

// Ship class by ESI group name. Order in the summary: see SHIP_CLASSES in app/js/fork/intel-scans.js
const SHIP_CLASS = {
	'Titan': 'titan',
	'Supercarrier': 'super',
	'Dreadnought': 'capital', 'Lancer Dreadnought': 'capital', 'Carrier': 'capital', 'Force Auxiliary': 'capital',
	'Capital Industrial Ship': 'capital', 'Command Carrier': 'capital', 'Jump Freighter': 'industrial', 'Freighter': 'industrial',
	'Battleship': 'battleship', 'Black Ops': 'battleship', 'Marauder': 'battleship',
	'Combat Battlecruiser': 'battlecruiser', 'Attack Battlecruiser': 'battlecruiser', 'Command Ship': 'battlecruiser',
	'Strategic Cruiser': 't3c', 'Tactical Destroyer': 't3d',
	'Heavy Interdiction Cruiser': 'hic',
	'Interdictor': 'dictor',
	'Logistics': 'logistics', 'Logistics Frigate': 'logistics',
	'Cruiser': 'cruiser', 'Heavy Assault Cruiser': 'cruiser', 'Force Recon Ship': 'cruiser', 'Combat Recon Ship': 'cruiser',
	'Flag Cruiser': 'cruiser', 'Expedition Command Ship': 'cruiser',
	'Destroyer': 'destroyer', 'Command Destroyer': 'destroyer',
	'Frigate': 'frigate', 'Assault Frigate': 'frigate', 'Covert Ops': 'frigate', 'Interceptor': 'frigate',
	'Electronic Attack Ship': 'frigate', 'Stealth Bomber': 'frigate', 'Expedition Frigate': 'frigate',
	'Prototype Exploration Ship': 'frigate', 'Corvette': 'frigate',
	'Hauler': 'industrial', 'Deep Space Transport': 'industrial', 'Blockade Runner': 'industrial',
	'Mining Barge': 'industrial', 'Exhumer': 'industrial', 'Industrial Command Ship': 'industrial',
	'Capsule': 'pod', 'Shuttle': 'shuttle'
};

async function get(url, body) {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(url, {
			method: body ? 'POST' : 'GET',
			headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Content-Type': 'application/json' },
			body: body ? JSON.stringify(body) : undefined
		});
		if (res.ok) { return res.json(); }
		if (attempt >= 3 || res.status < 500) { throw new Error(url + ': HTTP ' + res.status); }
		await new Promise((r) => setTimeout(r, 2000 * attempt));
	}
}

/** {groups: Set of ship group IDs, types: Set of ship type IDs} that can fit one of CYNO_MODULES */
async function cynoFits() {
	const groups = new Set();
	const types = new Set();
	const attributeNames = {};
	for (const moduleID of CYNO_MODULES) {
		const module = await get(ESI + '/universe/types/' + moduleID + '/');
		for (const a of module.dogma_attributes || []) {
			if (!(a.attribute_id in attributeNames)) {
				attributeNames[a.attribute_id] = (await get(ESI + '/dogma/attributes/' + a.attribute_id + '/')).name || '';
			}
			const name = attributeNames[a.attribute_id];
			if (/^canFitShipGroup\d+$/.test(name)) { groups.add(Math.round(a.value)); }
			if (/^canFitShipType\d+$/.test(name)) { types.add(Math.round(a.value)); }
		}
		console.log(module.name + ': fits groups/types from its canFitShip* attributes');
	}
	return { groups, types };
}

async function main() {
	const cyno = await cynoFits();
	const groups = {};	// id -> [name, kind, shipClass]
	const typeGroup = {};	// typeID -> groupID
	const unmapped = [];
	for (const [categoryID, kind] of Object.entries(CATEGORIES)) {
		const category = await get(ESI + '/universe/categories/' + categoryID + '/');
		for (const groupID of category.groups) {
			const group = await get(ESI + '/universe/groups/' + groupID + '/');
			if (!group.published || !group.types || !group.types.length) { continue; }
			let shipClass = '';
			if (kind === 'ship') {
				shipClass = SHIP_CLASS[group.name] || '';
				if (!shipClass) { unmapped.push(group.name); }
			}
			groups[groupID] = [group.name, kind, shipClass];
			group.types.forEach((t) => { typeGroup[t] = groupID; });
		}
	}
	for (const [groupID, [name, kind]] of Object.entries(EXTRA_GROUPS)) {
		const group = await get(ESI + '/universe/groups/' + groupID + '/');
		groups[groupID] = [name, kind, ''];
		// Planets and moons come in a few types each; wrecks are many, which is fine
		group.types.forEach((t) => { typeGroup[t] = Number(groupID); });
	}

	// Names, 1000 IDs per request; only published types (unpublished ones never show up in the client)
	const ids = Object.keys(typeGroup).map(Number).sort((a, b) => a - b);
	const names = {};
	for (let i = 0; i < ids.length; i += 1000) {
		const chunk = ids.slice(i, i + 1000);
		const answer = await get(ESI + '/universe/names/', chunk);
		answer.forEach((e) => { names[e.id] = e.name; });
	}
	const types = {};
	let skipped = 0;
	for (const id of ids) {
		const name = names[id];
		// Skip test / placeholder types
		if (!name || /^#|\bQA\b|^Test |\(Test\)|^\[?DEPRECATED/i.test(name)) { skipped++; continue; }
		const group = groups[typeGroup[id]];
		const canCyno = group[1] === 'ship' && (cyno.groups.has(typeGroup[id]) || cyno.types.has(id));
		types[id] = canCyno ? [name, typeGroup[id], 1] : [name, typeGroup[id]];
	}
	const out = {
		comment: 'Generated by intel/tools/generate-types.js from ESI /universe and /dogma (public data); do not edit. '
			+ 'types: typeID -> [name, groupID, 1 if it can fit a normal, covert or industrial cyno]; '
			+ 'groups: groupID -> [name, kind, shipClass]',
		generated: new Date().toISOString().slice(0, 10),
		groups: groups,
		types: types
	};
	const file = path.join(__dirname, '..', '..', 'public', 'intel', 'types.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(out) + '\n');
	console.log('public/intel/types.json: ' + Object.keys(types).length + ' types (' + skipped + ' skipped), '
		+ Object.keys(groups).length + ' groups, ' + fs.statSync(file).size + ' bytes');
	if (unmapped.length) { console.log('Ship groups without a class (shown as "Other ships"): ' + unmapped.join(', ')); }
}

main().catch((e) => { console.error(e); process.exit(1); });
