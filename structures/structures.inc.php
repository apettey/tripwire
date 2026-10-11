<?php
// Fork-owned: structures (Upwell, POS, deployables) recorded per mask and system, with owner, state and one timer
// each (feature "Structures", spec: reports/Structures and timers spec.md, phase 1). Used by public/structures.php.
//
// The data is per system, not per chain: a system that leaves the chain keeps its structures. D-scan rows are
// classified with the static type data in public/intel/types.json (group kind structure / starbase / deployable)
// and parsed with intel/intel.inc.php; app/js/fork/structures.js mirrors parse and merge for the preview (shared
// fixtures: structures/tests/fixtures.json). Owners are looked up in the cache the pilot lookups keep
// (fork_pilot_entities, intel/pilots.inc.php); this file never calls ESI or zKillboard.

require_once(__DIR__ . '/../intel/intel.inc.php');
require_once(__DIR__ . '/../intel/pilots.inc.php');

const STRUCTURES_LIVE_MAX      = 200;     // live rows per mask and system
const STRUCTURES_RATE_PER_MIN  = 20;      // writes per user per minute
const STRUCTURES_GONE_DAYS     = 30;      // destroyed / removed rows are kept this long (Undo)
const STRUCTURES_DEPLOYABLE_DAYS = 7;     // deployables not seen for this long are deleted
const STRUCTURES_TIMER_PAST    = 7200;    // a timer may be logged this long after it ended; it stays "active" this long
const STRUCTURES_TIMER_FUTURE  = 2592000; // 30 days
const STRUCTURES_NOTE_MAX      = 500;
const STRUCTURES_TOWER_GROUP   = 365;     // "Control Tower" in types.json

const STRUCTURES_STATES = ['unknown', 'online', 'low_power', 'abandoned', 'anchoring', 'unanchoring', 'reinforced', 'offline', 'destroyed', 'removed'];
const STRUCTURES_TIMER_KINDS = ['armor', 'hull', 'pos', 'anchoring', 'unanchoring', 'fuel', 'other'];
const STRUCTURES_TIMER_STATE = ['armor' => 'reinforced', 'hull' => 'reinforced', 'pos' => 'reinforced', 'anchoring' => 'anchoring', 'unanchoring' => 'unanchoring'];

// ---- Database ----

const STRUCTURES_DDL = [
    'CREATE TABLE IF NOT EXISTS fork_structures (
        id int unsigned NOT NULL AUTO_INCREMENT,
        maskID decimal(12,1) NOT NULL,
        systemID int NOT NULL,
        typeID int unsigned DEFAULT NULL,
        typeName varchar(100) NOT NULL,
        kind varchar(12) NOT NULL,
        name varchar(100) NOT NULL DEFAULT \'\',
        ownerID bigint unsigned DEFAULT NULL,
        ownerType varchar(12) DEFAULT NULL,
        ownerName varchar(255) DEFAULT NULL,
        ownerTicker varchar(10) DEFAULT NULL,
        ownerText varchar(100) DEFAULT NULL,
        state varchar(16) NOT NULL DEFAULT \'unknown\',
        timerKind varchar(16) DEFAULT NULL,
        timerAt datetime DEFAULT NULL,
        timerSetBy varchar(100) DEFAULT NULL,
        timerSetAt datetime DEFAULT NULL,
        note varchar(500) NOT NULL DEFAULT \'\',
        firstSeenAt datetime NOT NULL,
        firstSeenBy varchar(100) DEFAULT NULL,
        lastSeenAt datetime NOT NULL,
        lastSeenBy varchar(100) DEFAULT NULL,
        lastDistanceKm double DEFAULT NULL,
        updatedAt datetime NOT NULL,
        updatedBy varchar(100) DEFAULT NULL,
        goneAt datetime DEFAULT NULL,
        goneBy varchar(100) DEFAULT NULL,
        PRIMARY KEY (id),
        KEY mask_system (maskID, systemID),
        KEY mask_timer (maskID, timerAt),
        KEY gone (goneAt)
    ) DEFAULT CHARSET=utf8mb4',
    // Rate limit: one row per write request
    'CREATE TABLE IF NOT EXISTS fork_structure_writes (
        userID int NOT NULL,
        at datetime NOT NULL,
        KEY user_at (userID, at)
    ) DEFAULT CHARSET=utf8mb4',
];

function structures_schema(PDO $db) {
    foreach (STRUCTURES_DDL as $ddl) {
        if ($db->exec($ddl) === false) throw new PDOException('Could not create the structures tables: ' . implode(' ', $db->errorInfo()));
    }
}

/** Seconds since the Unix epoch of a UTC datetime column, independent of the session time zone */
function structures_ts($column) {
    return "TIMESTAMPDIFF(SECOND, '1970-01-01', $column)";
}

/** @return bool whether the user may write now (and records the write) */
function structures_rate_ok(PDO $db, $userID) {
    $db->exec("DELETE FROM fork_structure_writes WHERE at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE");
    $stmt = $db->prepare('SELECT COUNT(*) FROM fork_structure_writes WHERE userID = :u AND at > UTC_TIMESTAMP() - INTERVAL 1 MINUTE');
    $stmt->bindValue(':u', (int) $userID, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_structure_writes');
    if ((int) $stmt->fetchColumn() >= STRUCTURES_RATE_PER_MIN) return false;
    $ins = $db->prepare('INSERT INTO fork_structure_writes (userID, at) VALUES (:u, UTC_TIMESTAMP())');
    $ins->bindValue(':u', (int) $userID, PDO::PARAM_INT);
    $ins->execute();
    return true;
}

/** Delete gone rows after 30 days and deployables not seen for 7 days; Upwell and POS are never removed. @return int rows deleted */
function structures_prune(PDO $db) {
    $a = $db->exec('DELETE FROM fork_structures WHERE goneAt IS NOT NULL AND goneAt < UTC_TIMESTAMP() - INTERVAL ' . (int) STRUCTURES_GONE_DAYS . ' DAY');
    $b = $db->exec("DELETE FROM fork_structures WHERE kind = 'deployable' AND goneAt IS NULL AND lastSeenAt < UTC_TIMESTAMP() - INTERVAL " . (int) STRUCTURES_DEPLOYABLE_DAYS . ' DAY');
    if ($a === false || $b === false) throw new PDOException('Could not prune fork_structures');
    try {   // dismissed hints of structures that are gone
        $db->exec('DELETE d FROM fork_structure_hint_dismissed d LEFT JOIN fork_structures s ON s.id = d.structureID WHERE s.id IS NULL');
    } catch (PDOException $error) {
        if ((string) $error->getCode() !== '42S02') throw $error;
    }
    return $a + $b;
}

/** A corporation / alliance ticker column of an overview: 2-5 capitals, digits, dots or dashes, optionally in [] <> () */
function structures_ticker_like($cell) {
    return preg_match('/^[\[<(]?[A-Z0-9][A-Z0-9.\-]{1,4}[\]>)]?$/', (string) $cell) === 1;
}

// ---- Types and parsing ----

/** Static type data (public/intel/types.json), loaded once */
function structures_types() {
    static $types = null;
    if ($types === null) {
        $json = @file_get_contents(__DIR__ . '/../public/intel/types.json');
        $types = $json === false ? null : json_decode($json, true);
        if (!is_array($types)) $types = ['types' => [], 'groups' => []];
    }
    return $types;
}

/**
 * Structure info of a d-scan row, or null when it is not a structure (ships, drones, celestials, ...).
 * @return array|null [typeID, typeName, kind (upwell|starbase|deployable), tower (bool)]
 */
function structures_type_info($typeID, $typeName, $types = null) {
    $types = $types ?: structures_types();
    $t = null;
    $id = null;
    if ($typeID !== null && isset($types['types'][(string) $typeID])) {
        $t = $types['types'][(string) $typeID];
        $id = (int) $typeID;
    } elseif ($typeName !== '' && $typeName !== null) {
        $want = mb_strtolower((string) $typeName, 'UTF-8');
        foreach ($types['types'] as $tid => $row) {
            if (mb_strtolower($row[0], 'UTF-8') === $want) { $t = $row; $id = (int) $tid; break; }
        }
    }
    if (!$t || !isset($types['groups'][(string) $t[1]])) return null;
    $group = $types['groups'][(string) $t[1]];
    $map = ['structure' => 'upwell', 'starbase' => 'starbase', 'deployable' => 'deployable'];
    if (!isset($map[$group[1]])) return null;
    return [$id, $t[0], $map[$group[1]], (int) $t[1] === STRUCTURES_TOWER_GROUP];
}

/** Upwell names are "<system> - <name>": [the system part when it is a J-code or a short plain name else '', the rest] */
function structures_split_name($name) {
    if (preg_match('/^(J[0-9]{6}) - (.*)$/s', (string) $name, $m)) return [$m[1], $m[2]];
    if (preg_match('/^([A-Za-z0-9\'][A-Za-z0-9\' -]{0,23}?) - (.+)$/s', (string) $name, $m)) return [$m[1], $m[2]];
    return ['', (string) $name];
}

/**
 * Structures of a d-scan paste. POS modules are counted, not listed.
 * @return array ['structures' => [[typeID, typeName, kind, name, km|null, prefix, rest, wrong (bool)], ...],
 *                'modules' => n, 'notRecognised' => n (lines that are not structures: ships, drones, ...), 'invalid' => n]
 */
function structures_parse_scan($text, $systemName = null) {
    $parsed = intel_parse_dscan($text);
    $out = [];
    $modules = 0;
    $other = 0;
    foreach ($parsed['rows'] as [$typeID, $typeName, $name, $km]) {
        $info = structures_type_info($typeID, $typeName);
        if (!$info) { $other++; continue; }
        [$id, $canonical, $kind, $tower] = $info;
        if ($kind === 'starbase' && !$tower) { $modules++; continue; }
        [$prefix, $rest] = structures_split_name($name);
        $wrong = $kind === 'upwell' && $prefix !== '' && $systemName !== null && $systemName !== ''
            && preg_match('/^J[0-9]{6}$/', $prefix) === 1 && strcasecmp($prefix, $systemName) !== 0;
        $out[] = [$id, $canonical, $kind, $name, $km, $prefix, $rest, $wrong];
    }
    return ['structures' => $out, 'modules' => $modules, 'notRecognised' => $other, 'invalid' => $parsed['invalid']];
}

/**
 * Structures of a copied overview selection (spec 3.3, best effort). Overview rows are tab-separated with the columns the
 * pilot chose, so a row is read by cell content: the first cell that is exactly a structure type name is the type, the first
 * cell that reads as a distance (intel_parse_distance_km) the distance, and the name is the longest other cell, preferring
 * those that contain " - " (Upwell names); a name equal to the type name is no name. Rows without a type cell are not
 * structures. Same result as structures_parse_scan (JS mirror: structures.parseOverview).
 * @return array ['structures' => [[typeID, typeName, kind, name, km|null, prefix, rest, wrong], ...], 'modules' => n, 'notRecognised' => n, 'invalid' => 0]
 */
function structures_parse_overview($text, $systemName = null) {
    $out = [];
    $modules = 0;
    $other = 0;
    foreach (intel_lines($text) as $line) {
        $cells = array_map(function ($c) { return intel_clean_field($c); }, explode("\t", $line));
        $typeAt = null;
        $info = null;
        foreach ($cells as $i => $cell) {
            if ($cell === '') continue;
            $found = structures_type_info(null, $cell);
            if ($found && mb_strtolower($found[1], 'UTF-8') === mb_strtolower($cell, 'UTF-8')) { $typeAt = $i; $info = $found; break; }
        }
        if ($info === null) { $other++; continue; }
        [$id, $canonical, $kind, $tower] = $info;
        if ($kind === 'starbase' && !$tower) { $modules++; continue; }
        $km = null;
        $kmAt = null;
        foreach ($cells as $i => $cell) {
            if ($i === $typeAt || $cell === '') continue;
            $value = intel_parse_distance_km($cell);
            if ($value !== null) { $km = $value; $kmAt = $i; break; }
        }
        $name = '';
        $withDash = false;
        foreach ($cells as $i => $cell) {
            if ($i === $typeAt || $i === $kmAt || $cell === '' || $cell === '-' || structures_ticker_like($cell)) continue;
            $dash = strpos($cell, ' - ') !== false;
            if (($dash && !$withDash) || ($dash === $withDash && mb_strlen($cell, 'UTF-8') > mb_strlen($name, 'UTF-8'))) { $name = $cell; $withDash = $dash; }
        }
        if (mb_strtolower($name, 'UTF-8') === mb_strtolower($canonical, 'UTF-8')) $name = '';
        [$prefix, $rest] = structures_split_name($name);
        $wrong = $kind === 'upwell' && $prefix !== '' && $systemName !== null && $systemName !== ''
            && preg_match('/^J[0-9]{6}$/', $prefix) === 1 && strcasecmp($prefix, $systemName) !== 0;
        $out[] = [$id, $canonical, $kind, $name, $km, $prefix, $rest, $wrong];
    }
    return ['structures' => $out, 'modules' => $modules, 'notRecognised' => $other, 'invalid' => 0];
}

/**
 * Match scanned structures with stored rows of the same mask and system. Pure function (JS mirror: structures.merge).
 * @param array $existing [['id', 'typeID', 'name', 'removed' (bool)], ...] live rows and removed rows (not destroyed ones)
 * @param array $incoming [['typeID', 'name'], ...]
 * @return array per incoming index: ['id' => existing id|null, 'restore' => bool]
 */
function structures_merge(array $existing, array $incoming) {
    $used = [];
    $order = [];
    foreach ($existing as $i => $e) $order[] = [$e['removed'] ? 1 : 0, $i];
    usort($order, function ($a, $b) { return $a[0] <=> $b[0] ?: $a[1] <=> $b[1]; });
    $out = [];
    foreach ($incoming as $in) {
        $found = null;
        [, $inRest] = structures_split_name($in['name']);
        foreach ([1, 2, 3] as $rule) {
            foreach ($order as [, $i]) {
                if (isset($used[$i])) continue;
                $e = $existing[$i];
                if ((int) $e['typeID'] !== (int) $in['typeID']) continue;
                [, $eRest] = structures_split_name($e['name']);
                if ($rule === 1) $ok = $in['name'] !== '' && mb_strtolower($e['name'], 'UTF-8') === mb_strtolower($in['name'], 'UTF-8');
                elseif ($rule === 2) $ok = $inRest !== '' && mb_strtolower($eRest, 'UTF-8') === mb_strtolower($inRest, 'UTF-8');
                else $ok = $in['name'] === '' && $e['name'] === '';
                if ($ok) { $found = $i; break 2; }
            }
        }
        if ($found === null) {
            $out[] = ['id' => null, 'restore' => false];
        } else {
            $used[$found] = true;
            $out[] = ['id' => (int) $existing[$found]['id'], 'restore' => (bool) $existing[$found]['removed']];
        }
    }
    return $out;
}

// ---- Owner (cache only) ----

/**
 * Look a typed ticker or name up in the corporation / alliance cache (fork_pilot_entities), exact and case-insensitive.
 * @return array ['match' => [id, type, name, ticker]] | ['choices' => [[id, type, name, ticker], ...]] | []
 */
function structures_owner_lookup(PDO $db, $text) {
    $text = intel_clean_field($text);
    if ($text === '') return [];
    $stmt = $db->prepare("SELECT id, kind, name, ticker FROM fork_pilot_entities WHERE name IS NOT NULL
        AND kind IN ('corporation', 'alliance') AND (name = :t1 OR ticker = :t2) ORDER BY id LIMIT 10");
    $stmt->bindValue(':t1', $text);
    $stmt->bindValue(':t2', $text);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_pilot_entities');
    $rows = array_map(function ($r) { return [(int) $r['id'], $r['kind'], (string) $r['name'], (string) $r['ticker']]; }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    if (count($rows) === 1) return ['match' => $rows[0]];
    return $rows ? ['choices' => $rows] : [];
}

/** A cached entity by id and type: [id, type, name, ticker], or null */
function structures_owner_by_id(PDO $db, $id, $type) {
    $stmt = $db->prepare("SELECT id, kind, name, ticker FROM fork_pilot_entities WHERE id = :id AND kind = :k AND name IS NOT NULL");
    $stmt->bindValue(':id', (int) $id, PDO::PARAM_INT);
    $stmt->bindValue(':k', (string) $type);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_pilot_entities');
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    return $r ? [(int) $r['id'], $r['kind'], (string) $r['name'], (string) $r['ticker']] : null;
}

// ---- Timer ----

/** Parse "2026-10-12 18:30", "2026.10.12 18:30[:SS]" or ISO (Z / +00:00 / none = UTC) to a unix time, or null */
function structures_parse_time($value) {
    $v = trim((string) $value);
    if (!preg_match('/^(\d{4})[-.](\d{2})[-.](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/', $v, $m)) return null;
    if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1]) || (int) $m[4] > 23 || (int) $m[5] > 59) return null;
    $t = gmmktime((int) $m[4], (int) $m[5], isset($m[6]) && $m[6] !== '' ? (int) $m[6] : 0, (int) $m[2], (int) $m[3], (int) $m[1]);
    if (!empty($m[7]) && $m[7] !== 'Z') {
        $sign = $m[7][0] === '-' ? -1 : 1;
        $digits = str_replace(':', '', substr($m[7], 1));
        $t -= $sign * ((int) substr($digits, 0, 2) * 3600 + (int) substr($digits, 2, 2) * 60);
    }
    return $t;
}

/** Whether a timer end is acceptable on save: from 2 hours ago to 30 days ahead */
function structures_timer_in_range($timerAt, $now) {
    return $timerAt >= $now - STRUCTURES_TIMER_PAST && $timerAt <= $now + STRUCTURES_TIMER_FUTURE;
}

// ---- Rows ----

function structures_select() {
    return 'SELECT id, systemID, typeID, typeName, kind, name, ownerID, ownerType, ownerName, ownerTicker, ownerText, state, timerKind, '
        . structures_ts('timerAt') . ' AS timerAt, timerSetBy, ' . structures_ts('timerSetAt') . ' AS timerSetAt, note, ' . structures_ts('firstSeenAt') . ' AS firstSeenAt, firstSeenBy, '
        . structures_ts('lastSeenAt') . ' AS lastSeenAt, lastSeenBy, lastDistanceKm, ' . structures_ts('updatedAt') . ' AS updatedAt, updatedBy, '
        . structures_ts('goneAt') . ' AS goneAt, goneBy FROM fork_structures';
}

/** 'ours' / 'hostile' for a resolved owner, 'unknown' without one. @param array $friendly intel_friendly_ids() */
function structures_side(array $r, array $friendly) {
    if ($r['ownerID'] === null) return 'unknown';
    $ours = in_array((int) $r['ownerID'], $r['ownerType'] === 'alliance' ? $friendly['alliances'] : $friendly['corporations'], true);
    return $ours ? 'ours' : 'hostile';
}

/** A database row as the browser gets it. @param array $friendly intel_friendly_ids() */
function structures_format(array $r, array $friendly) {
    $int = function ($v) { return $v === null ? null : (int) $v; };
    $side = structures_side($r, $friendly);
    return [
        'id' => (int) $r['id'], 'systemID' => (int) $r['systemID'], 'typeID' => $int($r['typeID']), 'typeName' => $r['typeName'],
        'kind' => $r['kind'], 'name' => $r['name'],
        'ownerID' => $int($r['ownerID']), 'ownerType' => $r['ownerType'], 'ownerName' => $r['ownerName'], 'ownerTicker' => $r['ownerTicker'],
        'ownerText' => $r['ownerText'], 'side' => $side,
        'state' => $r['state'], 'timerKind' => $r['timerKind'], 'timerAt' => $int($r['timerAt']), 'timerSetBy' => $r['timerSetBy'], 'timerSetAt' => $int($r['timerSetAt']),
        'note' => $r['note'],
        'firstSeenAt' => $int($r['firstSeenAt']), 'lastSeenAt' => $int($r['lastSeenAt']), 'lastSeenBy' => $r['lastSeenBy'],
        'lastDistanceKm' => $r['lastDistanceKm'] === null ? null : (float) $r['lastDistanceKm'],
        'updatedAt' => $int($r['updatedAt']), 'updatedBy' => $r['updatedBy'],
        'goneAt' => $int($r['goneAt']), 'goneBy' => $r['goneBy'],
    ];
}

/** One row of the mask, or null (other masks' rows are never visible) */
function structures_get(PDO $db, $mask, $id, array $friendly) {
    $stmt = $db->prepare(structures_select() . ' WHERE id = :id AND maskID = :mask');
    $stmt->bindValue(':id', (int) $id, PDO::PARAM_INT);
    $stmt->bindValue(':mask', $mask);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_structures');
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    return $r ? structures_format($r, $friendly) : null;
}

/** Live and recently gone rows of a system. @return array ['structures' => [...], 'gone' => [...], 'hash' => md5] */
function structures_list(PDO $db, $mask, $systemID, array $friendly) {
    // No prune here (list is polled): rows a prune would delete are just not listed; writes prune
    $stmt = $db->prepare(structures_select() . " WHERE maskID = :mask AND systemID = :s
        AND (goneAt IS NULL OR goneAt >= UTC_TIMESTAMP() - INTERVAL " . (int) STRUCTURES_GONE_DAYS . " DAY)
        AND NOT (kind = 'deployable' AND goneAt IS NULL AND lastSeenAt < UTC_TIMESTAMP() - INTERVAL " . (int) STRUCTURES_DEPLOYABLE_DAYS . " DAY)
        ORDER BY kind = 'upwell' DESC, kind = 'starbase' DESC, typeName, name, id");
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':s', (int) $systemID, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_structures');
    $live = [];
    $gone = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $row = structures_format($r, $friendly);
        if ($row['goneAt'] === null) $live[] = $row; else $gone[] = $row;
    }
    return ['structures' => $live, 'gone' => $gone, 'hash' => md5(json_encode([$live, $gone]))];
}

// ---- Timers board and chain map markers (phase 2) ----

const STRUCTURES_MARKERS_MAX = 500;   // systems per markers request
const STRUCTURES_BOARD_MAX   = 200;   // rows of the timers board
const STRUCTURES_NEXT        = 20;    // next timers sent with the markers
const STRUCTURES_NEXT_GRACE  = 120;   // ... which include ones that ended this many seconds ago (the alert for "ended")

/** WHERE part for live rows (not gone, deployables not seen for a week hidden as in structures_list) */
function structures_live_where() {
    return "goneAt IS NULL AND NOT (kind = 'deployable' AND lastSeenAt < UTC_TIMESTAMP() - INTERVAL " . (int) STRUCTURES_DEPLOYABLE_DAYS . ' DAY)';
}

/**
 * Active timers of the mask, soonest first: not ended more than 2 hours ago, whatever the system (in the chain or not).
 * @return array rows as structures_format()
 */
function structures_timers(PDO $db, $mask, array $friendly, $now, $limit = STRUCTURES_BOARD_MAX, $grace = STRUCTURES_TIMER_PAST) {
    $stmt = $db->prepare(structures_select() . ' WHERE maskID = :mask AND ' . structures_live_where() . ' AND timerAt IS NOT NULL
        AND timerAt >= DATE_ADD(\'1970-01-01\', INTERVAL :from SECOND) ORDER BY timerAt, id LIMIT ' . max(1, (int) $limit));
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':from', (int) $now - (int) $grace, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_structures');
    return array_map(function ($r) use ($friendly) { return structures_format($r, $friendly); }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

/**
 * Per system summary for the chain map: the Upwell / POS rows (count, hostile, types, owners, newest sighting) and the
 * soonest active timer of any live row (an upcoming one before an elapsed one). Systems with neither are left out.
 * @param int[] $systemIDs
 * @return array systemID => ['count', 'hostile', 'types' => [[name, n]], 'owners' => [ticker], 'lastSeen', 'nextTimer' => null | [...]]
 */
function structures_markers(PDO $db, $mask, array $systemIDs, array $friendly, $now) {
    $ids = array_values(array_unique(array_map('intval', $systemIDs)));
    if (!$ids) return [];
    $stmt = $db->prepare('SELECT id, systemID, typeName, kind, name, ownerID, ownerType, ownerTicker, ownerText, timerKind, '
        . structures_ts('timerAt') . ' AS timerAt, ' . structures_ts('lastSeenAt') . ' AS lastSeenAt FROM fork_structures
        WHERE maskID = :mask AND ' . structures_live_where() . ' AND systemID IN (' . implode(',', $ids) . ') ORDER BY id');
    $stmt->bindValue(':mask', $mask);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_structures');
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $sid = (int) $r['systemID'];
        if (!isset($out[$sid])) $out[$sid] = ['count' => 0, 'hostile' => false, 'types' => [], 'owners' => [], 'lastSeen' => null, 'nextTimer' => null];
        $e = &$out[$sid];
        if ($r['kind'] !== 'deployable') {
            $e['count']++;
            if (structures_side($r, $friendly) === 'hostile') $e['hostile'] = true;
            $e['types'][$r['typeName']] = ($e['types'][$r['typeName']] ?? 0) + 1;
            $owner = $r['ownerID'] !== null ? ($r['ownerTicker'] !== null && $r['ownerTicker'] !== '' ? $r['ownerTicker'] : null) : ($r['ownerText'] !== '' ? $r['ownerText'] : null);
            if ($owner !== null && !in_array($owner, $e['owners'], true)) $e['owners'][] = $owner;
            $seen = (int) $r['lastSeenAt'];
            if ($e['lastSeen'] === null || $seen > $e['lastSeen']) $e['lastSeen'] = $seen;
        }
        if ($r['timerAt'] !== null && (int) $r['timerAt'] >= $now - STRUCTURES_TIMER_PAST) {
            $at = (int) $r['timerAt'];
            $cur = $e['nextTimer'];
            $upcoming = $at > $now;
            $better = $cur === null
                || ($upcoming && ($cur['at'] <= $now || $at < $cur['at']))
                || (!$upcoming && $cur['at'] <= $now && $at > $cur['at']);
            if ($better) $e['nextTimer'] = ['id' => (int) $r['id'], 'kind' => $r['timerKind'], 'at' => $at, 'typeName' => $r['typeName'], 'name' => $r['name']];
        }
        unset($e);
    }
    foreach ($out as $sid => &$e) {
        if ($e['count'] === 0 && $e['nextTimer'] === null) { unset($out[$sid]); continue; }
        $types = [];
        foreach ($e['types'] as $name => $n) $types[] = [(string) $name, $n];
        usort($types, function ($a, $z) { return $z[1] <=> $a[1] ?: strcmp($a[0], $z[0]); });
        $e['types'] = array_slice($types, 0, 4);
        $e['owners'] = array_slice($e['owners'], 0, 3);
    }
    unset($e);
    ksort($out);
    return $out;
}

// ---- Suggestions from stored kills (phase 4) ----

const STRUCTURES_SUGGEST_DAYS = 30;   // killmails looked at (the pooled zKillboard feed keeps its own, shorter, window)
const STRUCTURES_SUGGEST_OWNERS = 2;  // owner candidates per structure
const STRUCTURES_HINT_KINDS = ['owner', 'destroyed'];

const STRUCTURES_HINT_DDL = 'CREATE TABLE IF NOT EXISTS fork_structure_hint_dismissed (
    structureID int unsigned NOT NULL,
    kind varchar(12) NOT NULL,
    hintKey varchar(32) NOT NULL,
    dismissedBy varchar(100) DEFAULT NULL,
    dismissedAt datetime NOT NULL,
    PRIMARY KEY (structureID, kind, hintKey)
) DEFAULT CHARSET=utf8mb4';

function structures_hint_schema(PDO $db) {
    if ($db->exec(STRUCTURES_HINT_DDL) === false) throw new PDOException('Could not create fork_structure_hint_dismissed: ' . implode(' ', $db->errorInfo()));
}

/** Hide one hint of a structure for everybody on the mask (kind 'owner': hintKey = the corporation ID, 'destroyed': the kill ID). */
function structures_hint_dismiss(PDO $db, $structureID, $kind, $key, $by) {
    if (!in_array($kind, STRUCTURES_HINT_KINDS, true) || !preg_match('/^[0-9]{1,20}$/', (string) $key)) return false;
    structures_hint_schema($db);
    $stmt = $db->prepare('INSERT INTO fork_structure_hint_dismissed (structureID, kind, hintKey, dismissedBy, dismissedAt) VALUES (:id, :k, :h, :by, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE dismissedBy = VALUES(dismissedBy), dismissedAt = VALUES(dismissedAt)');
    $stmt->bindValue(':id', (int) $structureID, PDO::PARAM_INT);
    $stmt->bindValue(':k', $kind);
    $stmt->bindValue(':h', (string) $key);
    $stmt->bindValue(':by', $by === null ? null : mb_substr((string) $by, 0, 100, 'UTF-8'));
    return $stmt->execute();
}

/** Dismissed hints of these structures: "<id>:<kind>:<key>" => true. Empty without the table. */
function structures_hints_dismissed(PDO $db, array $ids) {
    $ids = array_values(array_unique(array_map('intval', $ids)));
    if (!$ids) return [];
    try {
        $out = [];
        foreach ($db->query('SELECT structureID, kind, hintKey FROM fork_structure_hint_dismissed WHERE structureID IN (' . implode(',', $ids) . ')')->fetchAll(PDO::FETCH_NUM) as [$id, $kind, $key]) {
            $out[$id . ':' . $kind . ':' . $key] = true;
        }
        return $out;
    } catch (PDOException $error) {
        if ((string) $error->getCode() === '42S02') return [];
        throw $error;
    }
}

/**
 * Hints from the structure / starbase losses the pooled zKillboard feed stored for the system (zkill_killmails; only the
 * database is read, nothing is fetched). Never applied by themselves: the panel shows them as clickable chips, each with a
 * dismiss (fork_structure_hint_dismissed, shared by the mask).
 *  - 'destroyed': a kill of this structure's type here after the row was first seen (and, when the owner is known, of that
 *    owner): "was it killed?" -> [killID, killTime]. A kill is offered to at most one structure: the rows of its type that
 *    could be the victim are ranked, owner match first, then the least recently seen, and the best one gets it (three
 *    Athanors and one kill: one hint).
 *  - 'owner' (rows without an owner): the corporations that lost this type of structure here, most losses first, only those
 *    whose name the entity cache knows (others are queued for the worker once, so they show up on a later poll):
 *    [[id, 'corporation', name, ticker, losses]]
 * @param array $live structures_list()['structures']
 * @return array rowID => ['destroyed' => [killID, killTime] (optional), 'owner' => [...] (optional)]; rows without a hint are left out
 */
function structures_suggestions(PDO $db, $systemID, array $live, $now) {
    $typeIDs = [];
    foreach ($live as $r) if ($r['typeID'] !== null) $typeIDs[(int) $r['typeID']] = true;
    if (!$typeIDs) return [];
    try {
        $stmt = $db->prepare('SELECT killID, ' . structures_ts('killTime') . ' AS killTime, victimShipTypeID, victimCorporationID, victimAllianceID FROM zkill_killmails
            WHERE systemID = :s AND victimShipTypeID IN (' . implode(',', array_keys($typeIDs)) . ') AND killTime >= DATE_ADD(\'1970-01-01\', INTERVAL :from SECOND)
            ORDER BY killTime DESC LIMIT 200');
        $stmt->bindValue(':s', (int) $systemID, PDO::PARAM_INT);
        $stmt->bindValue(':from', (int) $now - STRUCTURES_SUGGEST_DAYS * 86400, PDO::PARAM_INT);
        if (!$stmt->execute()) return [];
        $kills = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        if ((string) $error->getCode() === '42S02') return [];   // the feed has never run
        throw $error;
    }
    if (!$kills) return [];
    $dismissed = structures_hints_dismissed($db, array_map(function ($r) { return $r['id']; }, $live));
    $out = [];
    $byID = [];
    foreach ($live as $r) $byID[(int) $r['id']] = $r;

    // Destroyed?: every kill (newest first) goes to the best row of its type that could be its victim
    foreach ($kills as $k) {
        $best = null;
        // Dismissed on any structure of this type here: the kill is dismissed for the system (not offered to the next one)
        foreach ($live as $r) {
            if ($r['typeID'] !== null && (int) $r['typeID'] === (int) $k['victimShipTypeID'] && isset($dismissed[$r['id'] . ':destroyed:' . $k['killID']])) continue 2;
        }
        foreach ($live as $r) {
            if ($r['typeID'] === null || (int) $r['typeID'] !== (int) $k['victimShipTypeID'] || isset($out[(int) $r['id']]['destroyed'])) continue;
            if ((int) $k['killTime'] <= (int) $r['firstSeenAt'] || isset($dismissed[$r['id'] . ':destroyed:' . $k['killID']])) continue;
            $matches = false;
            if ($r['ownerID'] !== null) {
                $victim = $r['ownerType'] === 'alliance' ? $k['victimAllianceID'] : $k['victimCorporationID'];
                if ($victim === null || (int) $victim !== (int) $r['ownerID']) continue;
                $matches = true;
            }
            // owner match first, then the one not seen for longest (a structure seen on a scan after the kill is still there)
            if ($best === null || ($matches && !$best[0]) || ($matches === $best[0] && (int) $r['lastSeenAt'] < (int) $best[1]['lastSeenAt'])) $best = [$matches, $r];
        }
        if ($best) $out[(int) $best[1]['id']]['destroyed'] = [(int) $k['killID'], (int) $k['killTime']];
    }

    // Possible owner for rows without one
    $corps = [];
    $candidates = [];
    foreach ($live as $r) {
        if ($r['typeID'] === null || $r['ownerID'] !== null) continue;
        $count = [];
        foreach ($kills as $k) {
            if ((int) $k['victimShipTypeID'] !== (int) $r['typeID']) continue;
            $c = $k['victimCorporationID'];
            if ($c === null || (function_exists('intel_is_npc_corp') && intel_is_npc_corp((int) $c)) || isset($dismissed[$r['id'] . ':owner:' . $c])) continue;
            $count[(int) $c] = ($count[(int) $c] ?? 0) + 1;   // keeps first-seen (newest) order for ties
        }
        arsort($count);
        $ids = array_slice(array_keys($count), 0, STRUCTURES_SUGGEST_OWNERS);
        if ($ids) { $candidates[(int) $r['id']] = [$ids, $count]; foreach ($ids as $c) $corps[$c] = true; }
    }
    // Names and tickers of the candidate corporations from the entity cache; unknown ones are queued once (INSERT IGNORE: no write on later polls)
    $known = [];
    if ($corps) {
        try {
            $in = implode(',', array_keys($corps));
            foreach ($db->query("SELECT id, name, ticker FROM fork_pilot_entities WHERE kind = 'corporation' AND name IS NOT NULL AND id IN ($in)")->fetchAll(PDO::FETCH_ASSOC) as $e) {
                $known[(int) $e['id']] = [(string) $e['name'], (string) $e['ticker']];
            }
            $missing = array_keys(array_diff_key($corps, $known));
            if ($missing) {
                $values = implode(',', array_fill(0, count($missing), "(?, 'corporation', 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())"));
                $db->prepare("INSERT IGNORE INTO fork_pilot_entities (id, kind, status, requestedAt, wantedAt) VALUES $values")->execute($missing);
            }
        } catch (PDOException $error) {
            if ((string) $error->getCode() !== '42S02') throw $error;
        }
    }
    foreach ($candidates as $id => [$ids, $count]) {
        $list = [];
        foreach ($ids as $c) if (isset($known[$c])) $list[] = [$c, 'corporation', $known[$c][0], $known[$c][1], (int) $count[$c]];
        if ($list) $out[$id]['owner'] = $list;
    }
    ksort($out);
    return $out;
}

function structures_live_count(PDO $db, $mask, $systemID) {
    $stmt = $db->prepare('SELECT COUNT(*) FROM fork_structures WHERE maskID = :mask AND systemID = :s AND goneAt IS NULL');
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':s', (int) $systemID, PDO::PARAM_INT);
    $stmt->execute();
    return (int) $stmt->fetchColumn();
}

/**
 * Save the kept structures of a d-scan. Matched rows get lastSeen / distance (a removed one is restored); owner,
 * state, timer and note are never changed by a scan. Rows missing from the scan are never flagged gone.
 * @param array $rows from structures_parse_scan()['structures'], only the ones to save
 * @return array ['added' => n, 'updated' => n, 'restored' => n, 'skipped' => n]
 */
function structures_apply_scan(PDO $db, $mask, $systemID, array $rows, $modules, $by) {
    $out = ['added' => 0, 'updated' => 0, 'restored' => 0, 'skipped' => 0];
    $stmt = $db->prepare("SELECT id, typeID, name, goneAt IS NOT NULL AS removed FROM fork_structures
        WHERE maskID = :mask AND systemID = :s AND (goneAt IS NULL OR state = 'removed')");
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':s', (int) $systemID, PDO::PARAM_INT);
    $stmt->execute();
    $existing = array_map(function ($r) { return ['id' => (int) $r['id'], 'typeID' => (int) $r['typeID'], 'name' => $r['name'], 'removed' => (bool) $r['removed']]; }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    $plan = structures_merge($existing, array_map(function ($r) { return ['typeID' => $r[0], 'name' => $r[3]]; }, $rows));
    $live = structures_live_count($db, $mask, $systemID);
    $towers = count(array_filter($rows, function ($r) { return $r[2] === 'starbase'; }));
    $by = $by === null ? null : mb_substr((string) $by, 0, 100, 'UTF-8');
    foreach ($rows as $i => $r) {
        if ($plan[$i]['id'] !== null) {
            $upd = $db->prepare('UPDATE fork_structures SET lastSeenAt = UTC_TIMESTAMP(), lastSeenBy = :by, lastDistanceKm = :km'
                . ($plan[$i]['restore'] ? ", state = 'unknown', goneAt = NULL, goneBy = NULL" : '') . ' WHERE id = :id AND maskID = :mask');
            $upd->bindValue(':by', $by);
            $upd->bindValue(':km', $r[4]);
            $upd->bindValue(':id', $plan[$i]['id'], PDO::PARAM_INT);
            $upd->bindValue(':mask', $mask);
            $upd->execute();
            if ($plan[$i]['restore']) $out['restored']++; else $out['updated']++;
            continue;
        }
        if ($live >= STRUCTURES_LIVE_MAX) { $out['skipped']++; continue; }
        $note = $r[2] === 'starbase' && $modules > 0 && $towers === 1 ? $modules . ' modules on the first scan' : '';
        $ins = $db->prepare('INSERT INTO fork_structures (maskID, systemID, typeID, typeName, kind, name, note, firstSeenAt, firstSeenBy,
            lastSeenAt, lastSeenBy, lastDistanceKm, updatedAt, updatedBy)
            VALUES (:mask, :s, :tid, :tn, :kind, :name, :note, UTC_TIMESTAMP(), :by, UTC_TIMESTAMP(), :by2, :km, UTC_TIMESTAMP(), :by3)');
        $ins->bindValue(':mask', $mask);
        $ins->bindValue(':s', (int) $systemID, PDO::PARAM_INT);
        $ins->bindValue(':tid', (int) $r[0], PDO::PARAM_INT);
        $ins->bindValue(':tn', $r[1]);
        $ins->bindValue(':kind', $r[2]);
        $ins->bindValue(':name', $r[3]);
        $ins->bindValue(':note', $note);
        $ins->bindValue(':by', $by);
        $ins->bindValue(':by2', $by);
        $ins->bindValue(':by3', $by);
        $ins->bindValue(':km', $r[4]);
        $ins->execute();
        $live++;
        $out['added']++;
    }
    return $out;
}

// ---- Manual add / edit / gone ----

/**
 * Apply the fields of an add/update request. Only keys present in $in change. Returns [changes, error]:
 * changes = column => value (SQL-ready, 'timerAt' as unix or null), error = message or null.
 * Owner: 'owner' (typed text) is looked up in the cache; 'ownerID' + 'ownerType' pick one of the offered choices.
 * An ambiguous owner is returned as ['choices' => ...] in the third element and nothing is saved.
 * @return array [array changes, string|null error, array|null ownerChoices]
 */
function structures_changes(PDO $db, array $in, $now, ?array $current = null) {
    $c = [];
    if (array_key_exists('state', $in)) {
        $state = (string) $in['state'];
        if (!in_array($state, STRUCTURES_STATES, true) || $state === 'destroyed' || $state === 'removed') return [[], 'Invalid state', null];
        $c['state'] = $state;
    }
    if (array_key_exists('note', $in)) $c['note'] = intel_clean_field($in['note'], STRUCTURES_NOTE_MAX);
    if (array_key_exists('name', $in)) $c['name'] = intel_clean_field($in['name']);
    if (array_key_exists('owner', $in) || array_key_exists('ownerID', $in)) {
        $text = array_key_exists('owner', $in) ? intel_clean_field($in['owner']) : '';
        if (isset($in['ownerID']) && $in['ownerID'] !== '') {
            $e = structures_owner_by_id($db, (int) $in['ownerID'], isset($in['ownerType']) ? $in['ownerType'] : '');
            if (!$e) return [[], 'Unknown owner', null];
            $c += ['ownerID' => $e[0], 'ownerType' => $e[1], 'ownerName' => $e[2], 'ownerTicker' => $e[3] === '' ? null : $e[3], 'ownerText' => null];
        } elseif ($text === '') {
            $c += ['ownerID' => null, 'ownerType' => null, 'ownerName' => null, 'ownerTicker' => null, 'ownerText' => null];
        } else {
            $found = structures_owner_lookup($db, $text);
            if (isset($found['choices'])) return [[], null, $found['choices']];
            if (isset($found['match'])) {
                $e = $found['match'];
                $c += ['ownerID' => $e[0], 'ownerType' => $e[1], 'ownerName' => $e[2], 'ownerTicker' => $e[3] === '' ? null : $e[3], 'ownerText' => null];
            } else {
                $c += ['ownerID' => null, 'ownerType' => null, 'ownerName' => null, 'ownerTicker' => null, 'ownerText' => $text];
            }
        }
    }
    if (array_key_exists('timerKind', $in) || array_key_exists('timerAt', $in)) {
        $kind = array_key_exists('timerKind', $in) ? (string) $in['timerKind'] : ($current['timerKind'] ?? '');
        if ($kind === '' || $kind === null) {
            $c += ['timerKind' => null, 'timerAt' => null];
        } else {
            if (!in_array($kind, STRUCTURES_TIMER_KINDS, true)) return [[], 'Invalid timer kind', null];
            $at = array_key_exists('timerAt', $in) ? structures_parse_time($in['timerAt']) : ($current['timerAt'] ?? null);
            if ($at === null) return [[], 'Invalid timer time', null];
            if (!structures_timer_in_range($at, $now)) return [[], 'The timer must end between 2 hours ago and 30 days from now', null];
            $c += ['timerKind' => $kind, 'timerAt' => $at];
            if (!array_key_exists('state', $c) && isset(STRUCTURES_TIMER_STATE[$kind])
                && (array_key_exists('timerKind', $in) || array_key_exists('timerAt', $in))) $c['state'] = STRUCTURES_TIMER_STATE[$kind];
        }
    }
    return [$c, null, null];
}

/** Write changes to a row of the mask. $c as returned by structures_changes(); the timer's setter is recorded when it changes */
function structures_update(PDO $db, $mask, $id, array $c, $by, $seenNow = false) {
    $sets = ['updatedAt = UTC_TIMESTAMP()', 'updatedBy = :by'];
    $binds = [':by' => $by === null ? null : mb_substr((string) $by, 0, 100, 'UTF-8')];
    foreach ($c as $col => $val) {
        if ($col === 'timerAt') {
            $sets[] = $val === null ? 'timerAt = NULL, timerSetBy = NULL, timerSetAt = NULL'
                : "timerAt = DATE_ADD('1970-01-01', INTERVAL :timerAt SECOND), timerSetBy = :by2, timerSetAt = UTC_TIMESTAMP()";
            if ($val !== null) { $binds[':timerAt'] = (int) $val; $binds[':by2'] = $binds[':by']; }
        } elseif (in_array($col, ['state', 'note', 'name', 'ownerID', 'ownerType', 'ownerName', 'ownerTicker', 'ownerText', 'timerKind'], true)) {
            $sets[] = "$col = :c_$col";
            $binds[":c_$col"] = $val;
        }
    }
    if ($seenNow) { $sets[] = 'lastSeenAt = UTC_TIMESTAMP(), lastSeenBy = :by3'; $binds[':by3'] = $binds[':by']; }
    $stmt = $db->prepare('UPDATE fork_structures SET ' . implode(', ', $sets) . ' WHERE id = :id AND maskID = :mask AND goneAt IS NULL');
    foreach ($binds as $k => $v) $stmt->bindValue($k, $v);
    $stmt->bindValue(':id', (int) $id, PDO::PARAM_INT);
    $stmt->bindValue(':mask', $mask);
    if (!$stmt->execute()) throw new PDOException('Could not update the structure');
    if ($stmt->rowCount() > 0) return true;
    // MySQL reports 0 rows when nothing changed (a repeat within the same second): check that the row is there
    $check = $db->prepare('SELECT 1 FROM fork_structures WHERE id = :id AND maskID = :mask AND goneAt IS NULL');
    $check->bindValue(':id', (int) $id, PDO::PARAM_INT);
    $check->bindValue(':mask', $mask);
    $check->execute();
    return $check->fetchColumn() !== false;
}

/** Mark destroyed / removed, or restore (back to 'unknown' state when the row was gone). @return bool whether a row changed */
function structures_set_gone(PDO $db, $mask, $id, $state, $by) {
    $by = $by === null ? null : mb_substr((string) $by, 0, 100, 'UTF-8');
    if ($state === 'restore') {
        $stmt = $db->prepare("UPDATE fork_structures SET state = 'unknown', goneAt = NULL, goneBy = NULL, updatedAt = UTC_TIMESTAMP(), updatedBy = :by
            WHERE id = :id AND maskID = :mask AND goneAt IS NOT NULL");
    } else {
        $stmt = $db->prepare('UPDATE fork_structures SET state = :state, goneAt = UTC_TIMESTAMP(), goneBy = :by, updatedAt = UTC_TIMESTAMP(), updatedBy = :by2
            WHERE id = :id AND maskID = :mask AND goneAt IS NULL');
        $stmt->bindValue(':state', $state);
        $stmt->bindValue(':by2', $by);
    }
    $stmt->bindValue(':by', $by);
    $stmt->bindValue(':id', (int) $id, PDO::PARAM_INT);
    $stmt->bindValue(':mask', $mask);
    if (!$stmt->execute()) throw new PDOException('Could not update the structure');
    return $stmt->rowCount() > 0;
}

/** Insert a manually added structure. @return int id */
function structures_insert(PDO $db, $mask, $systemID, $typeID, $typeName, $kind, array $c, $by) {
    $by = $by === null ? null : mb_substr((string) $by, 0, 100, 'UTF-8');
    $stmt = $db->prepare('INSERT INTO fork_structures (maskID, systemID, typeID, typeName, kind, name, state, note, firstSeenAt, firstSeenBy, lastSeenAt, lastSeenBy, updatedAt, updatedBy)
        VALUES (:mask, :s, :tid, :tn, :kind, :name, :state, :note, UTC_TIMESTAMP(), :by1, UTC_TIMESTAMP(), :by2, UTC_TIMESTAMP(), :by3)');
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':s', (int) $systemID, PDO::PARAM_INT);
    $stmt->bindValue(':tid', $typeID, $typeID === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
    $stmt->bindValue(':tn', $typeName);
    $stmt->bindValue(':kind', $kind);
    $stmt->bindValue(':name', isset($c['name']) ? $c['name'] : '');
    $stmt->bindValue(':state', isset($c['state']) ? $c['state'] : 'unknown');
    $stmt->bindValue(':note', isset($c['note']) ? $c['note'] : '');
    $stmt->bindValue(':by1', $by);
    $stmt->bindValue(':by2', $by);
    $stmt->bindValue(':by3', $by);
    if (!$stmt->execute()) throw new PDOException('Could not store the structure: ' . implode(' ', $stmt->errorInfo()));
    return (int) $db->lastInsertId();
}
