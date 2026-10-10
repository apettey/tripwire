---
name: tripwire-domain
description: EVE Online wormhole domain knowledge and code entry points for Tripwire. Use before any work touching wormhole, signature, chain map, statics, mass/life, routing/guidance, automapper, masks or EVE-Scout logic, or when writing UI text that uses EVE terms (K162, EOL, destab, static, C1-C6, high-sec, exits). Points to docs/eve-wormhole-primer.md and the key globals.
---

# Tripwire domain context

1. Read [docs/eve-wormhole-primer.md](../../../docs/eve-wormhole-primer.md) first if you are not sure what a
   wormhole class, static, K162, EOL, mass state, mask or chain is. It also has a glossary mapping
   terms to code.
2. Don't open `public/js/combine.js` whole (~95k lines). Its top-level keys are `appData.systems`,
   `regions`, `factions`, `wormholes`, `map`, `effects`, `mass`; grep for the key you need.
3. Use the game's words in UI text (EOL, destab, crit, static, K162, HS/LS/NS, C1-C6) and keep them
   consistent with existing labels.

## Key globals and entry points

| Name | What it is |
| --- | --- |
| `appData` (`public/js/combine.js`) | Static data. `systems[id]` = `{name, security, regionID, factionID, class?, effect?, statics?}`; `wormholes[TYPE]` = `{from, leadsTo, mass, jump, life}` (kg, "16 Hours"); `map.shortest` = gate adjacency keyed by `systemID - 30000000`; `mass[typeID]` = hull mass. |
| `appData.genericSystemTypes` | Destination kinds (`High-Sec`, `Class-3`, `Unknown`...). A sig whose far side isn't known stores the index into this list as its `systemID`. |
| `tripwire.systems`, `tripwire.map` | `appData` merged into `tripwire` (`app/js/tripwire/sync.js:29`). |
| `tripwire.client.signatures[id]` | Sigs in the current mask: `{id, signatureID ('abc123'), systemID, type, name, lifeLength, lifeLeft, ...}`. |
| `tripwire.client.wormholes[id]` | Holes: `{id, initialID, secondaryID, parent ('initial'/'secondary' = side with the real type), type ('????' unknown), life ('stable'/'critical'=EOL), mass ('stable'/'destab'/'critical')}`. |
| `tripwire.refresh(mode, payload, ok, always)` | Sends changes to the server and syncs (`app/js/tripwire.js:180`). Payload `{signatures: {add: [...], update: [...]}}`. |
| `chain` (`app/js/chain-map.js`) | Chain map. `chain.nodes(map)` builds the tree; `chain.data.systemsInChainMap[systemID].pathHome` = node list from the root; `chain.data.exits` = k-space systems in chain; `chain.redraw()`. |
| `systemAnalysis.analyse(systemID)` | Normalised system info: `class`, `systemTypeName` (`C3`, `HS`...), `systemTypeClass` (CSS), `genericSystemType`, `effectClass`. Extend via `systemAnalysis.addMutator`. |
| `wormholeAnalysis` | `targetSystemID`, `eligibleWormholeTypes(src, dst)`, `wormholeFromTypePair`, `likelyWormhole`, `dummyWormholes` (SML/MED/LRG/XLG sizes). |
| `sigDialog.openSignatureDialog({data: {mode: 'add' or 'update', signature: id}})` | Add/edit signature dialog (`app/js/dialogs/signature-dialog.js`); builds the wormhole payload, auto-fills K162. |
| `guidance.findShortestPath(tripwire.map.shortest, from-30000000, to-30000000)` | Gate route (`app/js/guidance.js`), honours `options.chain.routeSecurity` / `routeIgnore`. |
| `tripwire.autoMapper(from, to)` / `tripwire.EVE({...})` | Automapper on system change (`app/js/tripwire/automapper.js`, `eve.js`). |
| `options` (`app/js/options.js`) | User settings: `options.chain` (tabs, active, renderer, sigNameLocation, routing), `options.masks.active`, `options.signatures`; persist with `options.save()`. |
| `systemRendering`, `wormholeRendering` | HTML for systems, paths, effects, wormhole types and masses. |
| `eveScout` (`app/js/map-data-suppliers/eve-scout.js`) | Thera/Turnur connections as a third-party chain supplier. |
