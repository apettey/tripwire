# EVE wormhole primer (for agents working on Tripwire)

Tripwire is a shared, real-time map of wormhole connections for EVE Online. This page gives just enough
game knowledge to read the code and word the UI correctly. Game numbers marked "approx." change between
game patches; the source of truth for numbers in this repo is `public/js/combine.js` (`appData`).

## 1. EVE basics

- **New Eden**: the game universe. Players fly ships between **solar systems** (IDs `30000001`+ for
  normal space, `31000001`+ for wormhole space). Systems group into constellations and regions.
- **Stargates**: fixed links between normal-space systems. One gate hop = one **jump**. Gate routes are
  stable and public, so they can be pre-computed (`appData.map.shortest`).
- **Known space ("k-space")**: everything reachable by stargates. Classified by **security status**:
  - **High-sec** (0.5 to 1.0): police (CONCORD) punish attackers. Trade hubs (Jita, Amarr...) are here.
  - **Low-sec** (0.1 to 0.4): limited protection.
  - **Null-sec** (0.0 and below): no protection; player alliances own territory.
  - The in-game display rounds; `systemAnalysis.js` therefore uses `>= 0.45` for high-sec, `> 0.0` low,
    `<= 0.0` null.
- **Pochven**: a region taken by the **Triglavian** faction (factionID `500026`), cut off from the
  normal gate network; reached by special wormholes (e.g. `C729`) and filaments. Tripwire shows it as
  `Trig` / `▼`.
- **Thera**: a big special wormhole system (class 12) with many random connections all over New Eden;
  used as a shortcut hub. **Turnur** is a low-sec system that also gets Thera-like wormhole
  connections (approx. since 2023). The volunteer group **EVE-Scout** publishes Thera/Turnur
  connections; Tripwire can overlay them.
- **Zarzakh**: special system with a long (approx. 6h) jump lockout; routing always avoids it.
- **Ship mass** matters because wormholes limit mass per jump. Rough sizes (approx.):

  | Class | Typical mass | Can pass |
  | --- | --- | --- |
  | Frigate / destroyer | 1-2 kt (1 kt = 1,000 t = 1,000,000 kg) | every hole, incl. frigate-only (5 kt jump limit) |
  | Cruiser / battlecruiser | ~10-20 kt | medium holes (62 kt jump limit, e.g. into C1) and up |
  | Battleship | ~100 kt | large holes (375 kt) and up |
  | Freighter | ~950 kt (an Orca is ~150 kt and fits large holes) | holes with a 1,000 kt+ jump limit only |
  | Capital (carrier, dread, FAX) | ~1,200-1,300 kt | XL holes (2,000 kt), mainly between C5/C6 and to k-space from them |

  Supercarriers and titans cannot enter wormhole space (approx.: game rule, not a mass limit). Mass in `appData` is in **kg**; `wormholeRendering.renderMass`
  shows it as `kt` (`mass / 1e6`). `appData.mass[typeID]` has hull masses for the mass calculator.
- **EVE time** = UTC. Daily server **downtime** around 11:00 UTC.
- **ESI** (EVE Swagger Interface, `https://esi.evetech.net`) is CCP's public REST API. **EVE SSO** is
  CCP's OAuth login; Tripwire asks for location, ship, online status, waypoint and a few other
  scopes (README "Setup guide"). ESI calls live in `app/js/tripwire/esi.js`.

## 2. Wormholes

### Wormhole space (J-space, Anoikis)
- Approx. 2,600 systems with no stargates, named `J` + 6 digits (e.g. `J123456`), plus a few named
  ones (Thera, Drifter systems). Only reachable through wormholes (and a few filament mechanics).
- Local chat does not list pilots until they speak, so you only know who is around by scanning and
  watching. That is why mapping matters.
- **Classes** (`appData.systems[id].class`):

  | Class | Notes |
  | --- | --- |
  | C1-C3 | Easier sites; usually a static to k-space. Holes into a C1 are medium (62 kt jump, no battleships). |
  | C4 | Two J-space statics, no k-space static; mid-difficulty sites. |
  | C5-C6 | Hardest sites; capitals can be used and jump between C5/C6 and out to k-space. |
  | C12 | Thera. |
  | C13 | "Shattered" frigate-only systems. |
  | C14-C18 | Drifter systems (Sentinel, Barbican, Vidette, Conflux, Redoubt). |

  When you look at an unscanned hole in-game, the destination is described vaguely: "Unknown" (approx.
  C1-C3), "Dangerous" (C4-C5), "Deadly" (C6). Tripwire's `systemAnalysis.classForTypeName` maps its own
  generic types: `Unknown` → C2/C3, `Unknown (small)` → C1/C2/C3/C13, `Dangerous` → C4/C5.

  Many systems also have a **system effect** (Black Hole, Magnetar, Pulsar, Red Giant, Wolf-Rayet,
  Cataclysmic Variable) that changes ship stats (`appData.effects`, `systemAnalysis.effectClass`).
- `appData.genericSystemTypes` (`app/js/tripwire/genericSystemTypes.js`) is the list of *kinds* of
  destination (`Null-Sec`, `Low-Sec`, `High-Sec`, `Class-1`..`Class-6`, `Class-13`, `Triglavian`,
  `Unknown` (C2/C3), `Unknown (small)`, `Dangerous` (C4/C5), `Class-14`..`Class-18`). A signature whose
  far side is not identified yet stores the **index** into this list as its `systemID`.

### Connections
- A **wormhole** is a temporary link between two systems, seen as a cosmic signature at both ends.
- **Type code**: every hole has a 4-character type (e.g. `H296`, `C247`, `N110`). The type says what
  class it leads to, its size and lifetime. `appData.wormholes[TYPE]` =
  `{ from, leadsTo, mass, jump, life }` (e.g. `C247`: from Class-4, leads to Class-3, mass 2,000 kt,
  jump 375 kt, life 16 Hours). Some types also have `notFrom` / `notLeadsTo`.
- **K162**: the generic "exit" type. A hole is opened from one side (the side that shows the real
  type); the far side shows `K162`. So `K162` tells you nothing about size or destination by itself.
  It is not in `appData.wormholes`; the dialog adds it as a pseudo-type.
- **Statics**: every J-space system always has the same 1-2 (sometimes more) connection types. When a
  static dies a new one of the same type spawns. `appData.systems[id].statics` = list of type codes.
  Knowing statics tells a corp where they can always get to.
- **Wandering** holes: random extra connections (any type valid for the system class).
- **Total mass**: how much ship mass can pass in total before the hole collapses (`mass`).
  **Jump mass**: max mass of a single ship (`jump`). Tripwire's size buckets (`wormholeAnalysis.dummyWormholes`):
  `SML` 5 kt (frigate), `MED` 62 kt, `LRG` 375 kt, `XLG` 2,000 kt.
- **Mass state** (shown in-game when you look at the hole; stored in `wormholes.mass`):
  `stable` (>= 50% left), `destab` / destabilised (< 50%), `critical` (< 10%).
- **Lifetime**: each type has a total life (approx. 4.5h to 48h, see `life`). In-game, a hole under
  approx. 4h left is **EOL** ("end of life"). Stored as `wormholes.life` = `stable` | `critical` (EOL).
- **Collapsing / rolling**: pushing mass through on purpose (often a battleship going back and forth,
  with prop mods on or a Higgs anchor to change mass) to close a hole. Corps **roll** their static to
  get a fresh connection, or roll holes to cut off hostiles. Tripwire's mass panel has toggles for this
  (`app/js/mass.js`, `tripwire.massOptions = {higgs, prop}`).
- Jumping gives a short polarization timer (approx. a few minutes) before you can jump that hole again.

### Scanning
- Every system has **cosmic signatures**, found with the **probe scanner** (scan probes). Each has an ID
  like `ABC-123` (3 letters + 3 digits). Tripwire stores it lowercase without the dash (`abc123`,
  `signatures.signatureID char(6)`); display via `formatSignatureID` (`app/js/global-hooks.js`).
- Signature types: **wormhole**, **combat**, **data**, **relic**, **gas**, **ore** (plus `unknown`
  until scanned). Same enum as the `signatures.type` column.
- Players paste the scanner window into Tripwire (`app/js/tripwire/paste.js`), which creates or
  updates sigs. Sigs have their own life timer (`lifeLength`, default 72h).
- **Bookmarks**: saved in-game locations (on the hole), usually shared via corp folders. Corps name
  them so anyone can read the chain from the bookmark list (see section 3).

## 3. How wormhole corps live

- A corp lives in a **home** (staging) J-space system. Their **chain** is everything reachable through
  holes from home: home → statics → their connections → ... (a tree, sometimes with loops).
- **Daily routine**: scan home every day (statics respawn, wanderers appear), then scan down the chain,
  record every sig and hole, mark EOL/mass state, and delete dead ones.
- Holes are the only way in or out. **Exits**: holes leading to k-space. The best exits are close (few
  gate jumps) to a trade hub like Jita; used for **logistics/hauling** loot out and supplies in.
- Activities: **PvE** (combat sites with Sleeper NPCs; loot "blue loot" sells for ISK), gas/ore
  mining, data/relic hacking; **PvP** hunting people in the chain; **evictions** (big groups siege and
  take a corp's home); rolling statics to find targets or to stay safe.
- Many pilots scan at once, in different systems, so a **shared real-time map** is essential.
- **Naming convention** (this fork's corp; used for sig names and bookmarks):
  - Each hole in the chain gets a hierarchical name; one character per depth, concatenated:
    `A`..`Z` for large holes, `1`-`5` for small (frigate) holes, `6`-`9` for medium holes.
    Example: home → `A` → `AB` → `AB6`.
  - In-game bookmark on the hole leading out (outbound side): `=A C2 XYZ [EOL]` (name, destination
    class, signature letters, optional `EOL` flag). On the far side, pointing back home: `<A`.
  - In Tripwire the name goes in the signature's `name`; the chain map can show it instead of / in
    front of the system name (`options.chain.sigNameLocation`).

## 4. How Tripwire maps onto this

| Concept | Where |
| --- | --- |
| **Masks**: who shares a map. Public `0.0`, private `<characterID>.1`, corp `<corpID>.2`, alliance `<allianceID>.3`, plus custom masks | `masks.inc.php`, `public/masks.php`, `options.masks.active` |
| **Signatures**: one row per sig per mask (`signatureID`, `systemID`, `type`, `name`, `lifeLength`/`lifeLeft`) | `.docker/mysql/tripwire.sql` (`CREATE TABLE signatures`), `signatures.php`, client `tripwire.client.signatures[id]` |
| **Wormholes**: links two signature rows. `initialID`/`secondaryID`; `parent` = `initial`/`secondary` says which side is the real (non-K162) type; `type`, `life`, `mass` | `CREATE TABLE wormholes`, client `tripwire.client.wormholes[id]` |
| Static data (`systems`, `regions`, `factions`, `wormholes`, `map.shortest`, `effects`, `mass`) | `public/js/combine.js` (`var appData = {...}`, ~95k lines; don't read whole); merged into `tripwire` (`tripwire.systems`, `tripwire.map`) at `app/js/tripwire/sync.js:29` |
| Sync loop: client posts changes, server returns sigs/holes/flares/occupied every ~5s | `tripwire.refresh` / `tripwire.sync` (`app/js/tripwire.js:180`, `app/js/tripwire/sync.js`), `public/refresh.php` |
| Signature add/edit dialog; builds the `{wormhole, signatures:[sig, sig2]}` payload; auto-fills `K162` on the other side | `app/js/dialogs/signature-dialog.js` (~line 262), `sigDialog.openSignatureDialog` |
| Chain map: walks wormholes outward from the viewed system (or the chain tab's systems) into a tree; adds statics badges, EOL/mass/frigate line modifiers | `chain.nodes` in `app/js/chain-map.js:153` (`findLinks` ~251) |
| Per-node path from the root: `chain.data.systemsInChainMap[systemID].pathHome` (list of nodes); `chain.data.exits` = k-space systems in chain | `app/js/chain-map.js:466-478` |
| Renderers: radial (default), orgChart, orgChartTop, orgChartSide | `app/js/chain-map-renderer*.js`, `options.chain.renderer` |
| Chain tabs: saved root systems (`options.chain.tabs[i].systemID`, comma list or `0` = all k-space roots), `evescout` flag | `app/js/options.js:14`, `chain.setActiveTab` |
| System info: class, security type, effect, display name, `genericSystemType` | `systemAnalysis.analyse(systemID)` (`app/js/systemAnalysis.js`), mutators in `app/js/system-mutators/` (favourites, Triglavian invasions) |
| Hole type logic: type → target, eligible types between two classes, size guess for unknown holes | `wormholeAnalysis` (`app/js/wormholeAnalysis.js`) |
| **Route guidance**: gate-jump shortest path, honouring route security / avoid list; shown as "calc" nodes to favourites / current system | `guidance.findShortestPath(tripwire.map.shortest, from-30000000, to-30000000)` (`app/js/guidance.js:136`), `options.chain.routeSecurity` |
| **Automapper**: when a tracked character changes system and it wasn't a gate jump, create or complete a hole | `tripwire.autoMapper(from, to)` (`app/js/tripwire/automapper.js:5`), triggered from `tripwire.EVE` (`app/js/tripwire/eve.js`), location polled via ESI (`esi.js`) |
| **Flares**: red/yellow/green colour on a system, per mask | `flares` table, `chain.flares` (`chain-map.js:110`), `public/flares.php` |
| **Occupants**: corp members tracked in a system | `chain.occupied`, `public/occupants.php` |
| **Activity**: ESI jumps/kills per system (dots on nodes, graph panel) | `chain-map.js:560`, `app/js/activity-graph.js`, `public/activity_graph.php` |
| **EVE-Scout** (Thera/Turnur public connections) as a third-party map supplier | `app/js/map-data-suppliers/eve-scout.js`, `public/cached_third_party.php` |
| Tracking characters (ESI location, ship) | `app/js/tracking.js`, `app/js/tripwire/esi.js` |

## 5. Glossary

| Term | Meaning | In Tripwire |
| --- | --- | --- |
| k-space | Known space, gate-connected | `security` on system, `High-Sec`/`Low-Sec`/`Null-Sec` generic types; `systemTypeName` HS/LS/NS |
| J-space / Anoikis / w-space | Wormhole space | systems with `class`, IDs `31xxxxxx` |
| HS / LS / NS | High / low / null security | `systemAnalysis` `systemTypeClass` `hisec`/`lowsec`/`nullsec` |
| C1..C6, C13 | Wormhole system class | `system.class`, CSS `class-N`, `Class-N` generic types |
| Trig / Pochven | Triglavian space | factionID `500026`, `Triglavian`, `▼` |
| Thera | Hub wormhole system, C12 | system `31000005`, `leadsTo: "Thera"` types |
| Drifter holes | C14-C18 systems | `Class-14`..`Class-18` |
| Static | Permanent connection type of a system | `appData.systems[id].statics`, `.statics` badges on nodes |
| Wanderer | Random extra hole | any non-static type |
| K162 | Exit side of a hole | `K162` pseudo-type; `parent` points at the other side |
| Type code | 4-char hole type (`H296`) | `appData.wormholes[TYPE]`, `wormholes.type` (`????` = unknown) |
| leadsTo / from | Destination / origin class of a type | `appData.wormholes[TYPE].leadsTo` / `.from` |
| Jump mass | Max single-ship mass | `.jump` (kg), `jm-<n>kt` line class |
| Total mass | Mass before collapse | `.mass` (kg) |
| Frig hole | 5 kt jump limit | `frigTypes` in `chain-map.js`, `SML`, `frig` class |
| Destab | Under 50% mass left | `wormholes.mass = 'destab'` |
| Crit | Under 10% mass left | `wormholes.mass = 'critical'` |
| EOL | End of life, under approx. 4h | `wormholes.life = 'critical'`, label "EOL" |
| Roll | Collapse a hole on purpose | mass panel, `tripwire.massOptions` |
| Sig / signature | Scannable site | `signatures` table, `#sigTable` |
| Sig ID | `ABC-123` | `signatureID` stored `abc123` |
| Paste | Copy of probe scanner results | `app/js/tripwire/paste.js` |
| Chain | Holes reachable from home | chain map, `chain.data` |
| Home / root | Start of a chain | chain tab `systemID`, top-level node |
| Exit | Hole to k-space | `chain.data.exits` |
| Mask | Sharing scope of a map | `maskID` (`x.0`/`.1`/`.2`/`.3`) |
| Flare | Coloured system marker | `flares` table, `chain.flares` |
| Automapper | Auto-create holes from jumps | `tripwire.autoMapper` |
| ESI / SSO | CCP API / login | `app/js/tripwire/esi.js`, `?mode=sso` |
| EVE-Scout | Public Thera/Turnur data | `map-data-suppliers/eve-scout.js` |
| Higgs / prop | Mass modifiers when rolling | `#higgs-jump`, `#hot-jump` |
