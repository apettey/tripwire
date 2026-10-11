<?php
// Fork-owned: the Watchlist's server side (see docker/README.md#watchlist).
//
// A corporation's Tripwire admins keep named filters per mask (the corp mask and corporation-owned custom masks, the
// same masks and admins as the Discord notifications); every member of the mask reads them (public/watchlist.php)
// and the browser matches them against its chain map (app/js/fork/watchlist.js). The Discord type "Watchlist match"
// (discord/watchlist.php) matches them here, in discord_notify.worker.php, so Discord is told even when nobody has
// Tripwire open.
//
// The matcher below is a port of the browser's (watchlist.normaliseConditions, classKeys, leadsToKeys, matchEntry,
// entriesFromLinks, match). Both are run against the same cases, watchlist/tests/cases.json (mocha:
// app/js-test/fork/watchlist.test.js, PHP: watchlist/tests/watchlist_test.php), so they can't drift apart.
// Static data: appData in public/js/combine.js, the same file the browser matches with (read once per process).

const WATCHLIST_MAX_FILTERS = 50;
const WATCHLIST_MAX_NAME = 60;
const WATCHLIST_CLASSES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'Thera', 'Shattered', 'Drifter', 'Pochven', 'HS', 'LS', 'NS'];
const WATCHLIST_EFFECTS = ['Wolf-Rayet Star', 'Pulsar', 'Magnetar', 'Black Hole', 'Cataclysmic Variable', 'Red Giant'];
const WATCHLIST_SIZES = ['S', 'M', 'L', 'VL', 'XL'];
const WATCHLIST_SIZE_MAX = [5000000, 62000000, 410000000, 1000000000];   // kg per size class (sizeTags.classes); above: XL

const WATCHLIST_DDL = [
    // Filters per mask: a JSON list of {id, name, enabled, conditions, updatedAt (unix), updatedBy}, normalised by
    // watchlist_normalise_filters(). One row per mask; admins change it in a transaction (SELECT ... FOR UPDATE).
    "CREATE TABLE IF NOT EXISTS `fork_watchlist` (
      `maskID` decimal(12,1) NOT NULL,
      `filters` mediumtext NOT NULL,
      `updatedBy` varchar(100) NOT NULL DEFAULT '',
      `updatedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    // The Discord type (discord/watchlist.php): per mask and filter, the state the matches were last recorded for
    // (stamp: when the type was turned on and the filter last saved / turned on). A new stamp records the chain's
    // matches again without announcing them.
    "CREATE TABLE IF NOT EXISTS `fork_watchlist_baseline` (
      `maskID` decimal(12,1) NOT NULL,
      `filterID` varchar(40) NOT NULL,
      `stamp` varchar(64) NOT NULL,
      `createdAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`, `filterID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    // ... and every (filter, system, hole) seen matching since: kept while the hole exists (no expiry), so a hole is
    // announced once however old it gets; removed when the hole is gone or the filter is paused / deleted.
    "CREATE TABLE IF NOT EXISTS `fork_watchlist_seen` (
      `maskID` decimal(12,1) NOT NULL,
      `filterID` varchar(40) NOT NULL,
      `systemID` int NOT NULL,
      `wormholeID` int NOT NULL,
      `createdAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`, `filterID`, `systemID`, `wormholeID`),
      KEY `wormhole` (`maskID`, `wormholeID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

function watchlist_ensure_schema(PDO $db) {
    foreach (WATCHLIST_DDL as $ddl) $db->exec($ddl);
}

// ---- Data ----

/** ['systems' => id => {name, security, regionID, constellationID?, factionID?, class?, effect?, statics?},
    'wormholes' => type => {leadsTo, jump}, 'regions' => id => name, 'byName' => UPPER NAME => system]. $set replaces
    it (tests). Read from public/js/combine.js once per process (the worker) or request (an admin's save). */
function watchlist_data(?array $set = null) {
    static $data = null;
    if ($set !== null) $data = watchlist_index($set);
    if ($data === null) $data = watchlist_index(watchlist_data_from_combine(__DIR__ . '/../public/js/combine.js'));
    return $data;
}

/**
 * The fields the matcher reads, from combine.js ("var appData = {...}", plain JSON after the "="): per system name,
 * security, region, constellation, faction, wormhole class, effect and statics; per wormhole type where it leads and
 * its max jump mass; region names. Empty lists when the file is missing or unreadable.
 */
function watchlist_data_from_combine($path) {
    $text = is_readable($path) ? (string) file_get_contents($path) : '';
    $start = strpos($text, '{');
    $app = $start === false ? null : json_decode(substr($text, $start), true);
    unset($text);
    if (!is_array($app)) {
        error_log('watchlist: cannot read appData from ' . $path);
        return [];
    }
    return watchlist_data_from_app($app);
}

/** watchlist_data_from_combine's lists from a decoded appData */
function watchlist_data_from_app(array $app) {
    $systems = [];
    foreach ($app['systems'] ?? [] as $id => $s) {
        $id = (int) $id;
        if ($id < 30000000 || $id >= 33000000 || !is_array($s)) continue;
        $out = ['name' => (string) ($s['name'] ?? ''), 'security' => (float) ($s['security'] ?? 0), 'regionID' => (int) ($s['regionID'] ?? 0)];
        if (!empty($s['constellationID'])) $out['constellationID'] = (int) $s['constellationID'];
        if (!empty($s['factionID'])) $out['factionID'] = (int) $s['factionID'];
        $class = is_array($s['class'] ?? null) ? ($s['class'][0] ?? null) : ($s['class'] ?? null);
        if ($class) $out['class'] = (int) $class;
        if (!empty($s['effect'])) $out['effect'] = (string) $s['effect'];
        if (!empty($s['statics']) && is_array($s['statics'])) $out['statics'] = array_values($s['statics']);
        $systems[$id] = $out;
    }
    $wormholes = [];
    foreach ($app['wormholes'] ?? [] as $type => $w) {
        if (is_array($w)) $wormholes[(string) $type] = ['leadsTo' => (string) ($w['leadsTo'] ?? ''), 'jump' => (float) ($w['jump'] ?? 0)];
    }
    $regions = [];
    foreach ($app['regions'] ?? [] as $id => $r) $regions[(int) $id] = is_array($r) ? (string) ($r['name'] ?? '') : (string) $r;
    return ['systems' => $systems, 'wormholes' => $wormholes, 'regions' => $regions];
}

function watchlist_index(array $data) {
    $data += ['systems' => [], 'wormholes' => [], 'regions' => []];
    $byName = [];
    foreach ($data['systems'] as $id => $system) {
        if (isset($system['name'])) $byName[strtoupper((string) $system['name'])] = $system;
    }
    $data['byName'] = $byName;
    return $data;
}

// ---- Normalisation (same rules as watchlist.normaliseConditions / normaliseFilter) ----

/** A value as JavaScript's Number() would read it for the inputs we accept (numbers, numeric strings), else NAN */
function watchlist_number($value) {
    if (is_int($value) || is_float($value)) return (float) $value;
    if (is_bool($value)) return $value ? 1.0 : 0.0;
    if ($value === null) return 0.0;
    if (is_string($value)) {
        $text = trim($value);
        if ($text === '') return 0.0;
        return is_numeric($text) ? (float) $text : NAN;
    }
    return NAN;
}

function watchlist_is_integer($n) {
    return is_float($n) && is_finite($n) && floor($n) === $n;
}

/** Real system ID (30000000-32999999) or null; like watchlist.toID */
function watchlist_to_id($value) {
    if ($value === null || $value === '' || is_bool($value)) return null;
    if (is_string($value) && !preg_match('/^\s*\d+\s*$/', $value)) return null;
    $n = watchlist_number($value);
    return watchlist_is_integer($n) && $n >= 30000000 && $n < 33000000 ? (int) $n : null;
}

/** 0-999 or null; like watchlist.positiveInt */
function watchlist_positive_int($value) {
    if ($value === null || $value === '' || is_bool($value)) return null;
    $n = watchlist_number($value);
    return watchlist_is_integer($n) && $n >= 0 && $n <= 999 ? (int) $n : null;
}

/** "h296 " -> "H296"; null if it doesn't look like a wormhole type */
function watchlist_type_code($value) {
    if (!is_string($value) && !is_int($value) && !is_float($value)) return null;
    $code = strtoupper(trim((string) $value));
    return preg_match('/^[A-Z][0-9]{3}$/', $code) ? $code : null;
}

function watchlist_pick($list, array $allowed) {
    $out = [];
    foreach (is_array($list) ? $list : [] as $value) {
        if (is_string($value) && in_array($value, $allowed, true) && !in_array($value, $out, true)) $out[] = $value;
    }
    return $out;
}

/** Conditions with only known keys and valid values, in the browser's key order */
function watchlist_normalise_conditions($c) {
    $c = is_array($c) ? $c : [];
    $out = [];
    $systemID = watchlist_to_id($c['systemID'] ?? null);
    if ($systemID) $out['systemID'] = $systemID;
    $regionID = watchlist_number($c['regionID'] ?? null);
    if (watchlist_is_integer($regionID) && $regionID >= 10000000 && $regionID < 13000000) $out['regionID'] = (int) $regionID;
    $constellationID = watchlist_number($c['constellationID'] ?? null);
    if (watchlist_is_integer($constellationID) && $constellationID >= 20000000 && $constellationID < 23000000) {
        $out['constellationID'] = (int) $constellationID;
        $ref = watchlist_to_id($c['constellationRef'] ?? null);
        if ($ref) $out['constellationRef'] = $ref;
    }
    $classes = watchlist_pick($c['classes'] ?? null, WATCHLIST_CLASSES);
    if ($classes) $out['classes'] = $classes;
    $effects = watchlist_pick($c['effects'] ?? null, WATCHLIST_EFFECTS);
    if ($effects) $out['effects'] = $effects;
    if (is_string($c['staticLeadsTo'] ?? null) && in_array($c['staticLeadsTo'], WATCHLIST_CLASSES, true)) $out['staticLeadsTo'] = $c['staticLeadsTo'];
    $staticType = watchlist_type_code($c['staticType'] ?? null);
    if ($staticType) $out['staticType'] = $staticType;
    $whType = watchlist_type_code($c['whType'] ?? null);
    if ($whType) $out['whType'] = $whType;
    if (is_string($c['whLeadsTo'] ?? null) && in_array($c['whLeadsTo'], WATCHLIST_CLASSES, true)) $out['whLeadsTo'] = $c['whLeadsTo'];
    if (is_string($c['minSize'] ?? null) && in_array($c['minSize'], WATCHLIST_SIZES, true)) $out['minSize'] = $c['minSize'];
    $me = watchlist_positive_int($c['maxJumpsMe'] ?? null);
    if ($me !== null) $out['maxJumpsMe'] = $me;
    $home = watchlist_positive_int($c['maxJumpsHome'] ?? null);
    if ($home !== null) $out['maxJumpsHome'] = $home;
    return $out;
}

/** A filter as {id, name, enabled, conditions} (+ updatedAt / updatedBy when stored), or null */
function watchlist_normalise_filter($f) {
    if (!is_array($f)) return null;
    // Like JavaScript's String(): true -> 'true'
    $text = function ($value) { return is_bool($value) ? ($value ? 'true' : 'false') : (is_scalar($value) ? (string) $value : ''); };
    $id = substr(preg_replace('/[^A-Za-z0-9_-]/', '', $text($f['id'] ?? null)), 0, 40);
    if ($id === '') return null;
    $name = trim($text($f['name'] ?? null));
    $name = mb_substr($name, 0, WATCHLIST_MAX_NAME);
    $out = [
        'id' => $id,
        'name' => $name !== '' ? $name : 'Unnamed filter',
        'enabled' => ($f['enabled'] ?? true) !== false,
        'conditions' => watchlist_normalise_conditions($f['conditions'] ?? null),
    ];
    if (isset($f['updatedAt']) && is_numeric($f['updatedAt'])) $out['updatedAt'] = max(0, (int) $f['updatedAt']);
    if (isset($f['updatedBy']) && is_string($f['updatedBy'])) $out['updatedBy'] = mb_substr($f['updatedBy'], 0, 100);
    return $out;
}

/** Unique filters (first of an ID wins), at most WATCHLIST_MAX_FILTERS */
function watchlist_normalise_filters($list) {
    $out = [];
    $seen = [];
    foreach (is_array($list) ? $list : [] as $f) {
        $filter = watchlist_normalise_filter($f);
        if (!$filter || isset($seen[$filter['id']])) continue;
        $seen[$filter['id']] = true;
        $out[] = $filter;
        if (count($out) >= WATCHLIST_MAX_FILTERS) break;
    }
    return $out;
}

function watchlist_has_conditions($c) {
    if (!is_array($c)) return false;
    foreach (array_keys($c) as $key) if ($key !== 'constellationRef') return true;
    return false;
}

function watchlist_needs_connection($c) {
    return is_array($c) && (!empty($c['whType']) || !empty($c['whLeadsTo']) || !empty($c['minSize']));
}

/** Whether a filter depends on who is looking (jumps from you / from home): the server can't evaluate it */
function watchlist_uses_location($c) {
    return is_array($c) && (array_key_exists('maxJumpsMe', $c) || array_key_exists('maxJumpsHome', $c));
}

// ---- Classes, statics, sizes ----

/** Like watchlist.classKeys: ['C5'], ['C13', 'Shattered'], ['Drifter', 'Shattered'], ['HS'], ['Pochven'] ... */
function watchlist_class_keys($system) {
    if (!is_array($system)) return [];
    $class = $system['class'] ?? null;
    if (is_array($class)) $class = $class[0] ?? null;
    $cls = watchlist_number($class);
    if (is_nan($cls)) $cls = 0.0;
    if ($cls >= 1 && $cls <= 6) return ['C' . (int) $cls];
    if ($cls == 13) return ['C13', 'Shattered'];
    if ($cls == 12) return ['Thera'];
    if ($cls >= 14 && $cls <= 18) return ['Drifter', 'Shattered'];
    if ($cls) return [];
    if ((float) ($system['regionID'] ?? 0) >= 11000000) return [];
    if ((int) ($system['factionID'] ?? 0) === 500026) return ['Pochven'];
    if (!isset($system['security']) || !is_numeric($system['security'])) return [];
    $security = (float) $system['security'];
    return [$security >= 0.45 ? 'HS' : ($security > 0.0 ? 'LS' : 'NS')];
}

/** Like watchlist.leadsToKeys: what a wormhole type's leadsTo text stands for */
function watchlist_leads_to_keys($leadsTo, array $data) {
    $text = (string) $leadsTo;
    if (preg_match('/^Class-(\d+)$/', $text, $m)) return watchlist_class_keys(['class' => (int) $m[1]]);
    $map = ['High-Sec' => ['HS'], 'Low-Sec' => ['LS'], 'Null-Sec' => ['NS'], 'Thera' => ['Thera'], 'Triglavian' => ['Pochven']];
    if (isset($map[$text])) return $map[$text];
    $system = $data['byName'][strtoupper($text)] ?? null;
    if ($system) return watchlist_class_keys($system);
    // Drifter hole types name the Drifter system's J-code, which the data lists under its in-game name
    return preg_match('/^J\d{6}$/', $text) ? ['Drifter', 'Shattered'] : [];
}

/** Size class of a max jump mass (kg), like sizeTags.sizeOf; null when unknown */
function watchlist_size_of($jump) {
    $jump = (float) $jump;
    if ($jump <= 0) return null;
    foreach (WATCHLIST_SIZE_MAX as $i => $max) if ($jump <= $max) return WATCHLIST_SIZES[$i];
    return 'XL';
}

// ---- Matching (same as watchlist.matchSystem / matchConnection / matchEntry / match) ----

function watchlist_match_system(array $c, $systemID, $system, array $data) {
    if (!is_array($system)) return false;
    if (!empty($c['systemID']) && $c['systemID'] !== (int) $systemID) return false;
    if (!empty($c['regionID']) && $c['regionID'] !== (int) ($system['regionID'] ?? 0)) return false;
    if (!empty($c['constellationID']) && $c['constellationID'] !== (int) ($system['constellationID'] ?? 0)) return false;
    $keys = watchlist_class_keys($system);
    if (!empty($c['classes']) && !array_intersect($c['classes'], $keys)) return false;
    if (!empty($c['effects']) && !in_array($system['effect'] ?? null, $c['effects'], true)) return false;
    if (!empty($c['staticLeadsTo']) || !empty($c['staticType'])) {
        $statics = is_array($system['statics'] ?? null) ? $system['statics'] : [];
        if (!empty($c['staticType']) && !in_array($c['staticType'], $statics, true)) return false;
        if (!empty($c['staticLeadsTo'])) {
            $found = false;
            foreach ($statics as $type) {
                $wh = $data['wormholes'][$type] ?? null;
                if ($wh && in_array($c['staticLeadsTo'], watchlist_leads_to_keys($wh['leadsTo'] ?? '', $data), true)) { $found = true; break; }
            }
            if (!$found) return false;
        }
    }
    return true;
}

/** One connection ({wormholeID, type, size}) against the connection conditions, all on the same hole */
function watchlist_match_connection(array $c, $connection, array $data) {
    if (!is_array($connection)) return false;
    $type = $connection['type'] ?? null;
    if (!empty($c['whType']) && $type !== $c['whType']) return false;
    if (!empty($c['whLeadsTo'])) {
        $wh = $type ? ($data['wormholes'][$type] ?? null) : null;
        if (!$wh || !in_array($c['whLeadsTo'], watchlist_leads_to_keys($wh['leadsTo'] ?? '', $data), true)) return false;
    }
    if (!empty($c['minSize'])) {
        $have = array_search($connection['size'] ?? null, WATCHLIST_SIZES, true);
        if ($have === false || $have < array_search($c['minSize'], WATCHLIST_SIZES, true)) return false;
    }
    return true;
}

/** The entry's connections that make the match: those fitting the connection conditions, or all of them */
function watchlist_matching_connections(array $c, array $entry, array $data) {
    $out = [];
    foreach ($entry['connections'] ?? [] as $connection) {
        if (watchlist_needs_connection($c) && !watchlist_match_connection($c, $connection, $data)) continue;
        $out[] = $connection;
    }
    return $out;
}

function watchlist_match_entry(array $c, array $entry, array $data) {
    if (!watchlist_has_conditions($c)) return false;
    $systemID = (int) $entry['systemID'];
    if (!watchlist_match_system($c, $systemID, $data['systems'][$systemID] ?? null, $data)) return false;
    foreach (['maxJumpsMe' => 'jumpsMe', 'maxJumpsHome' => 'jumpsHome'] as $limit => $field) {
        if (!array_key_exists($limit, $c)) continue;
        $jumps = $entry[$field] ?? null;
        if ($jumps === null || $jumps > $c[$limit]) return false;
    }
    if (watchlist_needs_connection($c)) return (bool) watchlist_matching_connections($c, $entry, $data);
    return true;
}

/**
 * The systems on a chain with their connections, from the chain's links (like watchlist.entriesFromLinks):
 * $systemIDs first (in order), then each link's ends ($link['a'], then $link['b']). Every link is a connection of
 * both of its (real) systems: {wormholeID, type (real type, never K162, else null), size ('S'..'XL' or null)}.
 */
function watchlist_entries_from_links(array $systemIDs, array $links) {
    $entries = [];
    $add = function ($id) use (&$entries) {
        $id = watchlist_to_id($id);
        if ($id && !isset($entries[$id])) $entries[$id] = ['systemID' => $id, 'connections' => []];
    };
    foreach ($systemIDs as $id) $add($id);
    foreach ($links as $link) { $add($link['a'] ?? null); $add($link['b'] ?? null); }
    foreach ($links as $link) {
        $type = watchlist_type_code($link['type'] ?? null);
        if ($type === 'K162') $type = null;
        $size = in_array($link['size'] ?? null, WATCHLIST_SIZES, true) ? $link['size'] : null;
        $wormholeID = $link['wormholeID'] ?? null;
        $connection = ['wormholeID' => $wormholeID, 'type' => $type, 'size' => $size];
        foreach ([$link['a'] ?? null, $link['b'] ?? null] as $end) {
            $id = watchlist_to_id($end);
            if (!$id) continue;
            $duplicate = false;
            if ($wormholeID !== null) foreach ($entries[$id]['connections'] as $existing) if ($existing['wormholeID'] === $wormholeID) { $duplicate = true; break; }
            if (!$duplicate) $entries[$id]['connections'][] = $connection;
        }
    }
    return array_values($entries);
}

/** Enabled filters against the entries: [{key, filterID, filterName, systemID, wormholeIDs}] */
function watchlist_match(array $filters, array $entries, array $data) {
    $out = [];
    foreach ($filters as $filter) {
        if (!$filter || empty($filter['enabled']) || !watchlist_has_conditions($filter['conditions'] ?? [])) continue;
        foreach ($entries as $entry) {
            if (!watchlist_match_entry($filter['conditions'], $entry, $data)) continue;
            $ids = [];
            foreach (watchlist_matching_connections($filter['conditions'], $entry, $data) as $connection) {
                if ($connection['wormholeID'] !== null) $ids[] = $connection['wormholeID'];
            }
            $out[] = ['key' => $filter['id'] . '|' . $entry['systemID'], 'filterID' => $filter['id'], 'filterName' => $filter['name'],
                'systemID' => (int) $entry['systemID'], 'wormholeIDs' => $ids];
        }
    }
    return $out;
}

// ---- Editing (admins, public/watchlist.php) ----

/**
 * A filter from an admin's request, checked against the static data: [filter, errors]. Conditions are normalised
 * like the browser does; IDs must exist (system, region, constellation, wormhole types; K162 is no type to look for),
 * a name and at least one condition are required. Keeps the ID of an existing filter, otherwise makes a new one;
 * updatedAt / updatedBy are set here, never taken from the request.
 */
function watchlist_validate_filter($input, array $existing, array $data, $by, $now = null) {
    $now = $now ?? time();
    $errors = [];
    $input = is_array($input) ? $input : [];
    $name = is_string($input['name'] ?? null) ? trim($input['name']) : '';
    if ($name === '') $errors[] = 'Give the filter a name';
    elseif (mb_strlen($name) > WATCHLIST_MAX_NAME) $errors[] = 'Name is too long (max ' . WATCHLIST_MAX_NAME . ' characters)';
    $c = watchlist_normalise_conditions($input['conditions'] ?? null);
    if (isset($c['systemID']) && !isset($data['systems'][$c['systemID']])) $errors[] = 'Unknown system';
    if (isset($c['regionID']) && !isset($data['regions'][$c['regionID']])) $errors[] = 'Unknown region';
    if (isset($c['constellationID'])) {
        $known = false;
        foreach ($data['systems'] as $system) if ((int) ($system['constellationID'] ?? 0) === $c['constellationID']) { $known = true; break; }
        if (!$known) $errors[] = 'Unknown constellation';
        if (isset($c['constellationRef']) && (int) ($data['systems'][$c['constellationRef']]['constellationID'] ?? 0) !== $c['constellationID']) unset($c['constellationRef']);
    }
    foreach (['staticType', 'whType'] as $field) {
        if (isset($c[$field]) && ($c[$field] === 'K162' || !isset($data['wormholes'][$c[$field]]))) $errors[] = 'Unknown wormhole type ' . $c[$field];
    }
    if (!$errors && !watchlist_has_conditions($c)) $errors[] = 'Add at least one condition';
    if ($errors) return [null, $errors];
    $ids = array_map(function ($f) { return $f['id']; }, $existing);
    $id = is_string($input['id'] ?? null) && in_array($input['id'], $ids, true) ? $input['id'] : watchlist_new_id($ids);
    return [[
        'id' => $id, 'name' => $name, 'enabled' => ($input['enabled'] ?? true) !== false, 'conditions' => $c,
        'updatedAt' => (int) $now, 'updatedBy' => mb_substr((string) $by, 0, 100),
    ], []];
}

function watchlist_new_id(array $used) {
    do { $id = 'f' . bin2hex(random_bytes(5)); } while (in_array($id, $used, true));
    return $id;
}

// ---- Storage ----

function watchlist_load(PDO $db, $maskID, $forUpdate = false) {
    $stmt = $db->prepare('SELECT filters FROM fork_watchlist WHERE maskID = ?' . ($forUpdate ? ' FOR UPDATE' : ''));
    $stmt->execute([(string) $maskID]);
    $json = $stmt->fetchColumn();
    return $json === false ? [] : watchlist_normalise_filters(json_decode($json, true));
}

function watchlist_save(PDO $db, $maskID, array $filters, $by) {
    $stmt = $db->prepare('INSERT INTO fork_watchlist (maskID, filters, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE filters = VALUES(filters), updatedBy = VALUES(updatedBy), updatedAt = VALUES(updatedAt)');
    $stmt->execute([(string) $maskID, json_encode(array_values($filters)), mb_substr((string) $by, 0, 100)]);
}

/** Filters for the browser: without who changed them when */
function watchlist_public_filters(array $filters) {
    return array_map(function ($f) {
        return ['id' => $f['id'], 'name' => $f['name'], 'enabled' => $f['enabled'], 'conditions' => (object) $f['conditions']];
    }, $filters);
}

// ---- A mask's chain, from the database (the Discord type; the query is discord_watchlist_links) ----

/**
 * One wormholes/signatures row as a link between two real systems: [wormholeID, a, b, type (real type, null when only
 * the K162 side or nothing is known), size (from the type), aSig, bSig (signature IDs as typed), typedSide ('a' / 'b':
 * the side the real type was scanned on)]. a is the wormhole's initial signature's system, b the secondary's (null when
 * not known).
 */
function watchlist_link_from_row(array $row, array $data) {
    $type = watchlist_type_code($row['type'] ?? null);
    if ($type === 'K162') $type = null;
    $jump = $type && isset($data['wormholes'][$type]) ? (float) $data['wormholes'][$type]['jump'] : 0;
    return [
        'wormholeID' => (int) $row['wormholeID'],
        'a' => watchlist_to_id($row['aSys']), 'b' => watchlist_to_id($row['bSys']),
        'type' => $type, 'size' => watchlist_size_of($jump),
        'aSig' => (string) $row['aSig'], 'bSig' => (string) $row['bSig'],
        'typedSide' => ($row['parent'] ?? '') === 'secondary' ? 'b' : 'a',
    ];
}
