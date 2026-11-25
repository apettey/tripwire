<?php
// Fork-owned: Hole statistics, the research log of the holes of a mask's home system (see docker/README.md#hole-statistics).
//
// One row per wormhole seen with one end in the mask's home system (Mask Admin > Discord > Home system, the only home a
// mask has): home's statics going out and the holes coming in. A row holds what is known of the hole (the home-side
// signature id and type, the far system and type) and fills in as people do: the type set later, the far side found
// later. Nothing is classified here: Hole statistics in the browser (app/js/fork/hole-roll-stats.js) decides at read time
// what is a static roll (home-side type is one of home's statics), an inbound hole (home side is a K162) or neither.
//
// Recording: signatures.php calls holestats_touch_wormhole / holestats_touch_signature after each wormhole write (dialog
// adds and edits, pastes, the automapper, undo/redo), and the holes a request touched are read and saved once, when the
// request ends (holestats_flush). So no client has to be open and nothing depends on a setting. A hole deleted and added
// again (a re-paste) is the same hole: the same home-side signature id within HOLESTATS_MERGE_HOURS of its first sighting
// is merged into its row. Rows are kept for ever (they are small, and they are the research data).
//
// Backfill: the first time Hole statistics is opened for a mask and home, the holes of home are read once from the audit
// log (fork_audit_log, AUDIT_LOG_DAYS of history) and from the map as it is now; a stamp per mask and home makes it run
// once, and re-running never duplicates (the audit row id is unique per mask, and the merge rule above).
//
// Never breaks a save: every hook catches everything and only logs to the PHP error log (like the audit log).

const HOLESTATS_DDL = "CREATE TABLE IF NOT EXISTS `fork_hole_log` (
      `id` bigint unsigned NOT NULL AUTO_INCREMENT,
      `maskID` decimal(12,1) NOT NULL,
      `homeSystemID` int NOT NULL,
      `wormholeID` int NOT NULL DEFAULT 0,
      `auditID` bigint unsigned NULL DEFAULT NULL,
      `homeSig` varchar(10) NOT NULL DEFAULT '',
      `homeType` varchar(12) NOT NULL DEFAULT '',
      `farSystemID` int NOT NULL DEFAULT 0,
      `farSig` varchar(10) NOT NULL DEFAULT '',
      `farType` varchar(12) NOT NULL DEFAULT '',
      `firstSeen` datetime NOT NULL,
      `lastUpdated` datetime NOT NULL,
      `source` varchar(8) NOT NULL DEFAULT 'live',
      `guessed` tinyint NOT NULL DEFAULT 0,
      PRIMARY KEY (`id`),
      UNIQUE KEY `mask_audit` (`maskID`, `auditID`),
      KEY `mask_home` (`maskID`, `homeSystemID`, `firstSeen`),
      KEY `mask_wormhole` (`maskID`, `wormholeID`),
      KEY `mask_sig` (`maskID`, `homeSystemID`, `homeSig`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

const HOLESTATS_BACKFILL_DDL = "CREATE TABLE IF NOT EXISTS `fork_hole_log_backfill` (
      `maskID` decimal(12,1) NOT NULL,
      `homeSystemID` int NOT NULL,
      `doneAt` datetime NOT NULL,
      `rows` int NOT NULL DEFAULT 0,
      PRIMARY KEY (`maskID`, `homeSystemID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

const HOLESTATS_MERGE_HOURS = 48;     // same home-side signature id within this long of the first sighting = same hole
const HOLESTATS_READ_MAX = 20000;     // rows the read endpoint returns (newest first)
const HOLESTATS_AUDIT_MAX = 200000;   // audit rows the backfill reads
const HOLESTATS_TOUCH_MAX = 500;      // wormholes / signatures one request may queue
// app/js/tripwire/genericSystemTypes.js: a signature whose far side isn't known stores the index into this list as systemID
const HOLESTATS_GENERIC = ['Null-Sec', 'Low-Sec', 'High-Sec', 'Class-1', 'Class-2', 'Class-3', 'Class-4', 'Class-5', 'Class-6', 'Class-13',
    'Triglavian', 'Unknown', 'Unknown (small)', 'Dangerous', 'Class-14', 'Class-15', 'Class-16', 'Class-17', 'Class-18'];

/** Run $fn; create the tables and run it again when one is missing */
function holestats_run(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        $db->exec(HOLESTATS_DDL);
        $db->exec(HOLESTATS_BACKFILL_DDL);
        return $fn();
    }
}

function holestats_mask_ok($mask) {
    return is_string($mask) && preg_match('/^[0-9]{1,10}\.[0-3]$/', $mask) === 1;
}

/** The mask's home system id (Mask Admin > Discord > Home system), 0 when none. $fresh: skip the per-request cache. */
function holestats_home(PDO $db, $mask, $fresh = false) {
    static $cache = [];
    $mask = (string) $mask;
    if (!$fresh && array_key_exists($mask, $cache)) return $cache[$mask];
    $home = 0;
    try {
        $stmt = $db->prepare('SELECT settings FROM discord_settings WHERE maskID = ?');
        $stmt->execute([$mask]);
        $json = $stmt->fetchColumn();
        $settings = is_string($json) ? json_decode($json, true) : null;
        $value = is_array($settings) && isset($settings['homeSystemID']) ? $settings['homeSystemID'] : 0;
        $home = is_numeric($value) && (int) $value >= 30000000 && (int) $value < 33000000 ? (int) $value : 0;
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') error_log('holestats: ' . $e->getMessage());   // no Discord table yet: no home
    }
    return $cache[$mask] = $home;
}

/** A signature id as stored ('abc123'), '' for none */
function holestats_sig($value) {
    $s = strtolower(trim((string) $value));
    return preg_match('/^[a-z0-9?]{1,10}$/', $s) === 1 ? $s : '';
}

/** Whether a signature id is complete (3 letters, 3 digits): only those can identify a hole again */
function holestats_sig_complete($sig) {
    return is_string($sig) && preg_match('/^[a-z]{3}[0-9]{3}$/', $sig) === 1;
}

function holestats_type($value) {
    $t = strtoupper(trim((string) $value));
    if ($t === '' || $t === '????' || preg_match('/^[A-Z0-9?]{1,12}$/', $t) !== 1) return '';
    return $t;
}

/**
 * What a hole looks like from home (pure), or null when neither end is in home.
 * $w: ['type', 'parent' ('initial'|'secondary'|null), 'aSystem', 'bSystem', 'aSig', 'bSig'] (a = initial signature).
 * The side named by parent has the real type ('????' = not known yet), the other side is the K162; no parent: neither is known.
 * Returns ['homeSig', 'homeType', 'farSystemID' (a real system or 0), 'farSig', 'farType'].
 */
function holestats_view(array $w, $homeID) {
    $homeID = (int) $homeID;
    if ($homeID <= 0) return null;
    $a = (int) ($w['aSystem'] ?? 0);
    $b = (int) ($w['bSystem'] ?? 0);
    if ($a === $homeID) $home = 'a';
    else if ($b === $homeID) $home = 'b';
    else return null;
    $far = $home === 'a' ? 'b' : 'a';
    $parent = $w['parent'] ?? null;
    $typed = $parent === 'initial' ? 'a' : ($parent === 'secondary' ? 'b' : null);
    $type = holestats_type($w['type'] ?? '');
    $sideType = function ($side) use ($typed, $type) {
        if ($typed === null) return '';
        return $typed === $side ? $type : 'K162';
    };
    $farSystem = $far === 'a' ? $a : $b;
    return [
        'homeSig' => holestats_sig($w[$home . 'Sig'] ?? ''),
        'homeType' => $sideType($home),
        'farSystemID' => $farSystem >= 30000000 ? $farSystem : 0,
        'farSig' => holestats_sig($w[$far . 'Sig'] ?? ''),
        'farType' => $sideType($far),
    ];
}

/**
 * Save what is known of one hole of home: the row of this wormhole, else (a re-added hole) the row with the same complete
 * home-side signature id first seen within HOLESTATS_MERGE_HOURS of $at, else a new row. Known values win over unknown ones
 * ('' / 0 never overwrite what a row has). $at: UTC 'Y-m-d H:i:s'. $opts: wormholeID, auditID, source, guessed.
 * Returns the row id (0 when a backfill row of that audit id exists already).
 */
function holestats_upsert(PDO $db, $mask, $homeID, array $view, $at, array $opts = []) {
    $wormholeID = (int) ($opts['wormholeID'] ?? 0);
    $auditID = isset($opts['auditID']) ? (int) $opts['auditID'] : null;
    $source = ($opts['source'] ?? 'live') === 'backfill' ? 'backfill' : 'live';
    $guessed = !empty($opts['guessed']) ? 1 : 0;
    return holestats_run($db, function () use ($db, $mask, $homeID, $view, $at, $wormholeID, $auditID, $source, $guessed) {
        $row = null;
        if ($auditID) {
            $stmt = $db->prepare('SELECT id FROM fork_hole_log WHERE maskID = ? AND auditID = ?');
            $stmt->execute([$mask, $auditID]);
            if ($stmt->fetchColumn()) return 0;   // backfilled already
        }
        if ($wormholeID > 0) {
            $stmt = $db->prepare('SELECT * FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ? AND wormholeID = ? ORDER BY id DESC LIMIT 1');
            $stmt->execute([$mask, (int) $homeID, $wormholeID]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        }
        if (!$row && holestats_sig_complete($view['homeSig'])) {
            $stmt = $db->prepare('SELECT * FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ? AND homeSig = ?
                AND firstSeen BETWEEN DATE_SUB(?, INTERVAL ' . HOLESTATS_MERGE_HOURS . ' HOUR) AND DATE_ADD(?, INTERVAL ' . HOLESTATS_MERGE_HOURS . ' HOUR)
                ORDER BY ABS(TIMESTAMPDIFF(SECOND, firstSeen, ?)), id DESC LIMIT 1');
            $stmt->execute([$mask, (int) $homeID, $view['homeSig'], $at, $at, $at]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        }
        if (!$row) {
            $stmt = $db->prepare('INSERT INTO fork_hole_log (maskID, homeSystemID, wormholeID, auditID, homeSig, homeType, farSystemID, farSig, farType, firstSeen, lastUpdated, source, guessed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([$mask, (int) $homeID, $wormholeID, $auditID, $view['homeSig'], $view['homeType'], (int) $view['farSystemID'], $view['farSig'], $view['farType'], $at, $at, $source, $guessed]);
            return (int) $db->lastInsertId();
        }
        $pick = function ($new, $old) { return $new !== '' && $new !== 0 ? $new : $old; };
        $typesKnown = $view['homeType'] !== '' || $view['farType'] !== '';
        // exact types (a live hole) replace guessed ones; guessed types never replace exact ones
        $replaceTypes = $typesKnown && (!$guessed || (int) $row['guessed'] === 1 || ($row['homeType'] === '' && $row['farType'] === ''));
        $stmt = $db->prepare('UPDATE fork_hole_log SET wormholeID = ?, homeSig = ?, homeType = ?, farSystemID = ?, farSig = ?, farType = ?, lastUpdated = GREATEST(lastUpdated, ?), guessed = ? WHERE id = ?');
        $stmt->execute([
            $wormholeID > 0 ? $wormholeID : (int) $row['wormholeID'],
            $pick($view['homeSig'], $row['homeSig']),
            $replaceTypes ? $view['homeType'] : $row['homeType'],
            $pick((int) $view['farSystemID'], (int) $row['farSystemID']),
            $pick($view['farSig'], $row['farSig']),
            $replaceTypes ? $view['farType'] : $row['farType'],
            $at,
            $replaceTypes ? $guessed : (int) $row['guessed'],
            (int) $row['id'],
        ]);
        return (int) $row['id'];
    });
}

// ---- live recording (hooks in signatures.php) ----

function &holestats_request_state() {
    static $state = ['wormholes' => [], 'signatures' => [], 'db' => null, 'mask' => null, 'registered' => false];
    return $state;
}

function holestats_queue(PDO $db, $kind, $id) {
    try {
        $id = (int) $id;
        $mask = isset($_SESSION['mask']) ? (string) $_SESSION['mask'] : '';
        if ($id <= 0 || !holestats_mask_ok($mask)) return;
        $state = &holestats_request_state();
        if ($state['mask'] !== null && $state['mask'] !== $mask) holestats_flush();   // never mix masks
        if (count($state[$kind]) >= HOLESTATS_TOUCH_MAX) return;
        $state['db'] = $db;
        $state['mask'] = $mask;
        $state[$kind][$id] = true;
        if (!$state['registered']) { $state['registered'] = true; register_shutdown_function('holestats_flush'); }
    } catch (Throwable $e) { error_log('holestats: ' . $e->getMessage()); }
}

/** A wormhole was added or changed (type, parent) */
function holestats_touch_wormhole(PDO $db, $wormholeID) { holestats_queue($db, 'wormholes', $wormholeID); }

/** A wormhole-type signature changed (its id, or where it is: the far side found) */
function holestats_touch_signature(PDO $db, $signature) {
    if (is_object($signature) && $signature->type === 'wormhole') holestats_queue($db, 'signatures', $signature->id);
}

/** Save the holes this request touched (runs when the request ends; tests call it directly). Never throws. */
function holestats_flush($now = null) {
    $state = &holestats_request_state();
    $wormholes = array_keys($state['wormholes']);
    $signatures = array_keys($state['signatures']);
    $db = $state['db'];
    $mask = $state['mask'];
    $state['wormholes'] = [];
    $state['signatures'] = [];
    $state['mask'] = null;
    if (!$db || (!$wormholes && !$signatures)) return 0;
    try {
        $home = holestats_home($db, $mask);
        if ($home <= 0) return 0;
        $at = gmdate('Y-m-d H:i:s', $now === null ? time() : (int) $now);
        $in = function ($ids) { return $ids ? implode(',', array_map('intval', $ids)) : '0'; };
        $stmt = $db->prepare('SELECT w.id, w.type, w.parent, a.systemID AS aSystem, b.systemID AS bSystem, a.signatureID AS aSig, b.signatureID AS bSig
            FROM wormholes w LEFT JOIN signatures a ON a.id = w.initialID LEFT JOIN signatures b ON b.id = w.secondaryID
            WHERE w.maskID = ? AND (w.id IN (' . $in($wormholes) . ') OR w.initialID IN (' . $in($signatures) . ') OR w.secondaryID IN (' . $in($signatures) . '))');
        $stmt->execute([$mask]);
        $saved = 0;
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $w) {
            $view = holestats_view($w, $home);
            if ($view === null) {
                // no end in home (any more): a hole that was put in home by mistake and moved is not home's
                holestats_run($db, function () use ($db, $mask, $home, $w) {
                    $db->prepare("DELETE FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ? AND wormholeID = ? AND source = 'live'")->execute([$mask, $home, (int) $w['id']]);
                });
                continue;
            }
            if (holestats_upsert($db, $mask, $home, $view, $at, ['wormholeID' => (int) $w['id']])) $saved++;
        }
        return $saved;
    } catch (Throwable $e) {
        error_log('holestats: ' . $e->getMessage());
        return 0;
    }
}

// ---- backfill (once per mask and home) ----

/** The game data the backfill needs: systems (class, security, factionID, statics) and wormhole types (from, leadsTo). $set replaces it (tests). */
function holestats_game_data(?array $set = null) {
    static $data = null;
    if ($set !== null) $data = $set;
    if ($data !== null) return $data;
    $path = __DIR__ . '/../public/js/combine.js';
    $text = is_readable($path) ? (string) file_get_contents($path) : '';
    $start = strpos($text, '{');
    $app = $start === false ? null : json_decode(substr($text, $start), true);
    unset($text);
    $data = ['systems' => [], 'wormholes' => []];
    if (!is_array($app)) { error_log('holestats: cannot read appData'); return $data; }
    foreach ($app['systems'] ?? [] as $id => $s) {
        if (!is_array($s)) continue;
        $class = is_array($s['class'] ?? null) ? ($s['class'][0] ?? null) : ($s['class'] ?? null);
        $data['systems'][(int) $id] = ['class' => $class ? (int) $class : 0, 'security' => (float) ($s['security'] ?? 0),
            'factionID' => (int) ($s['factionID'] ?? 0), 'statics' => is_array($s['statics'] ?? null) ? array_values($s['statics']) : []];
    }
    foreach ($app['wormholes'] ?? [] as $type => $w) {
        if (!is_array($w)) continue;
        $from = $w['from'] ?? [];
        $data['wormholes'][strtoupper((string) $type)] = ['from' => array_values(array_map('strval', is_array($from) ? $from : [$from])), 'leadsTo' => (string) ($w['leadsTo'] ?? '')];
    }
    return $data;
}

/** The kind of space of a system as wormhole types name it ('Class-5', 'High-Sec', 'Triglavian'...), '' when not known */
function holestats_space($systemID, array $data) {
    $systemID = (int) $systemID;
    if ($systemID >= 0 && $systemID < count(HOLESTATS_GENERIC)) {
        $g = HOLESTATS_GENERIC[$systemID];
        return in_array($g, ['Unknown', 'Unknown (small)', 'Dangerous'], true) ? '' : $g;   // several classes: not known
    }
    $s = $data['systems'][$systemID] ?? null;
    if (!$s) return '';
    if (!empty($s['class'])) return 'Class-' . (int) $s['class'];
    if ((int) $s['factionID'] === 500026) return 'Triglavian';
    return $s['security'] >= 0.45 ? 'High-Sec' : ($s['security'] > 0.0 ? 'Low-Sec' : 'Null-Sec');
}

/**
 * Which side has the real type of a backfilled hole whose audit rows never said (rows from before the audit log kept
 * `parent`). Pure. Returns [side ('a'|'b'|null), guessed (bool)].
 *  - no type: neither side is known (null, not a guess);
 *  - '????' (one side was a K162, the other not typed): the K162 is taken to be on the initial side, the system the
 *    hole was added from (how the Sig dialog and pastes are used: you scan the K162 where you are) - a guess;
 *  - a real type: the side where it can spawn and lead (wormhole from / leadsTo against both ends' space); when both
 *    sides fit, home's static type is taken as home's static, any other type as typed on the initial side - a guess.
 */
function holestats_guess_side($type, $homeSide, $aSystem, $bSystem, array $statics, array $data) {
    $type = strtoupper(trim((string) $type));
    if ($type === '') return [null, false];
    if ($type === '????') return ['b', true];
    $farSide = $homeSide === 'a' ? 'b' : 'a';
    $home = holestats_space($homeSide === 'a' ? $aSystem : $bSystem, $data);
    $far = holestats_space($homeSide === 'a' ? $bSystem : $aSystem, $data);
    $wh = $data['wormholes'][$type] ?? null;
    if (!$wh) return [in_array($type, $statics, true) ? $homeSide : 'a', true];
    $fits = function ($space, array $list) { return $space === '' || in_array($space, $list, true); };
    $out = $fits($home, $wh['from']) && $fits($far, [$wh['leadsTo']]);   // typed in home, leading out
    $in = $fits($far, $wh['from']) && $fits($home, [$wh['leadsTo']]);    // typed on the far side, leading into home
    if ($out && !$in) return [$homeSide, false];
    if ($in && !$out) return [$farSide, false];
    if (in_array($type, $statics, true)) return [$homeSide, true];
    return ['a', true];
}

/**
 * The holes of home in the audit log's wormhole rows (pure). $rows: fork_audit_log rows (id, at, action, systemID,
 * toSystemID, subject, detail) of entity 'wormhole', oldest first. Returns a list of
 * ['auditID', 'at', 'lastAt', 'view' => holestats_view()-like, 'guessed' => bool].
 * Reconstructed: the add (both systems, both signature ids, type, life/mass), later type / parent changes, where the far
 * side leads once found (a signature update), signature id corrections, and deletes. Not reconstructable: which side
 * carried the type when no row says `parent` (guessed, see holestats_guess_side), holes whose home end was added
 * elsewhere and moved to home later, and anything older than the audit log's retention.
 */
function holestats_backfill_plan(array $rows, $homeID, array $statics, array $data) {
    $homeID = (int) $homeID;
    $holes = [];
    $open = [];   // index into $holes of holes not deleted yet
    $find = function ($test) use (&$holes, &$open) {
        for ($i = count($open) - 1; $i >= 0; $i--) if ($test($holes[$open[$i]])) return $i;
        return -1;
    };
    foreach ($rows as $r) {
        $d = is_array($r['detail']) ? $r['detail'] : json_decode((string) $r['detail'], true);
        if (!is_array($d)) $d = [];
        $at = (string) $r['at'];
        $hasEnds = array_key_exists('from', $d) || array_key_exists('to', $d);
        $from = holestats_sig($d['from'] ?? '');
        $to = holestats_sig($d['to'] ?? '');
        if ($r['action'] === 'add') {
            $a = (int) $r['systemID'];
            $b = (int) $r['toSystemID'];
            if ($a !== $homeID && $b !== $homeID) continue;
            $holes[] = ['auditID' => (int) $r['id'], 'at' => $at, 'lastAt' => $at, 'aSystem' => $a, 'bSystem' => $b, 'aSig' => $from, 'bSig' => $to,
                'type' => isset($d['type']) ? (string) $d['type'] : (string) $r['subject'], 'parent' => $d['parent'] ?? null, 'gone' => false];
            $open[] = count($holes) - 1;
            continue;
        }
        if ($hasEnds) {
            // a wormhole row (update / delete): the hole with these two signature ids
            $i = $find(function ($h) use ($from, $to) { return $h['aSig'] === $from && $h['bSig'] === $to; });
            if ($i < 0) continue;
            $k = $open[$i];
            if ($r['action'] === 'delete') { array_splice($open, $i, 1); $holes[$k]['lastAt'] = $at; continue; }
            $changes = is_array($d['changes'] ?? null) ? $d['changes'] : [];
            if (isset($changes['type'][1])) $holes[$k]['type'] = (string) $changes['type'][1];
            if (isset($changes['parent'][1]) && in_array($changes['parent'][1], ['initial', 'secondary'], true)) $holes[$k]['parent'] = $changes['parent'][1];
            $holes[$k]['lastAt'] = $at;
            continue;
        }
        if ($r['action'] === 'update' && isset($d['id'])) {
            // one wormhole signature changed: its id, or its system (where the far side leads)
            $changes = is_array($d['changes'] ?? null) ? $d['changes'] : [];
            $was = isset($changes['signatureID'][0]) ? holestats_sig($changes['signatureID'][0]) : holestats_sig($d['id']);
            if ($was === '') continue;
            $i = $find(function ($h) use ($was) { return $h['aSig'] === $was || $h['bSig'] === $was; });
            if ($i < 0) continue;
            $k = $open[$i];
            $side = $holes[$k]['aSig'] === $was ? 'a' : 'b';
            if (isset($changes['signatureID'][1])) $holes[$k][$side . 'Sig'] = holestats_sig($changes['signatureID'][1]);
            if (isset($changes['systemID'][1])) {
                $homeSide = $holes[$k]['aSystem'] === $homeID ? 'a' : 'b';
                $new = (int) $changes['systemID'][1];
                if ($side === $homeSide && $new !== $homeID) { $holes[$k]['gone'] = true; array_splice($open, $i, 1); continue; }   // moved away from home
                if ($side !== $homeSide) $holes[$k][$side . 'System'] = $new;
            }
            $holes[$k]['lastAt'] = $at;
        }
    }
    $out = [];
    foreach ($holes as $h) {
        if ($h['gone']) continue;
        $homeSide = $h['aSystem'] === $homeID ? 'a' : 'b';
        $guessed = false;
        $parent = $h['parent'];
        if (!in_array($parent, ['initial', 'secondary'], true)) {
            [$side, $guessed] = holestats_guess_side($h['type'], $homeSide, $h['aSystem'], $h['bSystem'], $statics, $data);
            $parent = $side === 'a' ? 'initial' : ($side === 'b' ? 'secondary' : null);
        }
        $view = holestats_view(['type' => $h['type'], 'parent' => $parent, 'aSystem' => $h['aSystem'], 'bSystem' => $h['bSystem'], 'aSig' => $h['aSig'], 'bSig' => $h['bSig']], $homeID);
        if ($view === null) continue;
        $out[] = ['auditID' => $h['auditID'], 'at' => $h['at'], 'lastAt' => $h['lastAt'], 'view' => $view, 'guessed' => $guessed];
    }
    return $out;
}

/**
 * Backfill the holes of home once per mask and home: from the audit log, then the map as it is now (exact types, merged
 * into the audit rows by signature id). Returns ['doneAt', 'rows'] of the stamp, or null when there is no home. Never throws.
 */
function holestats_backfill(PDO $db, $mask, $homeID, $now = null) {
    $homeID = (int) $homeID;
    if ($homeID <= 0 || !holestats_mask_ok((string) $mask)) return null;
    try {
        $claimed = holestats_run($db, function () use ($db, $mask, $homeID) {
            $stmt = $db->prepare('INSERT IGNORE INTO fork_hole_log_backfill (maskID, homeSystemID, doneAt, `rows`) VALUES (?, ?, UTC_TIMESTAMP(), 0)');
            $stmt->execute([$mask, $homeID]);
            return $stmt->rowCount() > 0;
        });
        if ($claimed) {
            $rows = [];
            // Live recording may have run before the first backfill: the audit log only fills in the time before it
            // (holes without a complete signature id could not be matched to their live row)
            $stmt = $db->prepare("SELECT MIN(firstSeen) FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ? AND source = 'live'");
            $stmt->execute([$mask, $homeID]);
            $liveSince = $stmt->fetchColumn() ?: '9999-12-31 00:00:00';
            try {
                $stmt = $db->prepare("SELECT id, at, action, systemID, toSystemID, subject, detail FROM fork_audit_log WHERE maskID = ? AND entity = 'wormhole' AND at < ? ORDER BY at, id LIMIT " . HOLESTATS_AUDIT_MAX);
                $stmt->execute([$mask, $liveSince]);
                $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            } catch (PDOException $e) {
                if ($e->getCode() !== '42S02') throw $e;   // no audit log yet: nothing to read
            }
            if ($rows) {
                $data = holestats_game_data();
                $statics = array_map('strtoupper', $data['systems'][$homeID]['statics'] ?? []);
                foreach (holestats_backfill_plan($rows, $homeID, $statics, $data) as $h) {
                    $id = holestats_upsert($db, $mask, $homeID, $h['view'], $h['at'], ['auditID' => $h['auditID'], 'source' => 'backfill', 'guessed' => $h['guessed']]);
                    if ($id) {
                        $db->prepare('UPDATE fork_hole_log SET lastUpdated = GREATEST(lastUpdated, ?) WHERE id = ?')->execute([$h['lastAt'], $id]);
                    }
                }
            }
            // the holes on the map now (exact: parent is known), first seen when their home signature was created
            $stmt = $db->prepare('SELECT w.id, w.type, w.parent, a.systemID AS aSystem, b.systemID AS bSystem, a.signatureID AS aSig, b.signatureID AS bSig,
                    a.lifeTime AS aTime, b.lifeTime AS bTime
                FROM wormholes w JOIN signatures a ON a.id = w.initialID JOIN signatures b ON b.id = w.secondaryID
                WHERE w.maskID = ? AND (a.systemID = ? OR b.systemID = ?)');
            $stmt->execute([$mask, $homeID, $homeID]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $w) {
                $view = holestats_view($w, $homeID);
                if ($view === null) continue;
                $t = strtotime((string) ((int) $w['aSystem'] === $homeID ? $w['aTime'] : $w['bTime']));   // lifeTime: PHP's local time
                $at = gmdate('Y-m-d H:i:s', $t ? min($t, $now === null ? time() : (int) $now) : ($now === null ? time() : (int) $now));
                holestats_upsert($db, $mask, $homeID, $view, $at, ['wormholeID' => (int) $w['id'], 'source' => 'backfill']);
            }
            $stmt = $db->prepare("SELECT COUNT(*) FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ? AND source = 'backfill'");
            $stmt->execute([$mask, $homeID]);
            $db->prepare('UPDATE fork_hole_log_backfill SET `rows` = ? WHERE maskID = ? AND homeSystemID = ?')->execute([(int) $stmt->fetchColumn(), $mask, $homeID]);
        }
        $stmt = $db->prepare('SELECT doneAt, `rows` FROM fork_hole_log_backfill WHERE maskID = ? AND homeSystemID = ?');
        $stmt->execute([$mask, $homeID]);
        $stamp = $stmt->fetch(PDO::FETCH_ASSOC);
        return $stamp ? ['doneAt' => $stamp['doneAt'], 'rows' => (int) $stamp['rows']] : null;
    } catch (Throwable $e) {
        error_log('holestats: backfill ' . $e->getMessage());
        // let the next open try again (what was saved is merged, never duplicated)
        try { $db->prepare('DELETE FROM fork_hole_log_backfill WHERE maskID = ? AND homeSystemID = ?')->execute([$mask, $homeID]); } catch (Throwable $e2) { }
        return null;
    }
}

// ---- reading ----

/** The rows of the mask's current home, newest first (at most HOLESTATS_READ_MAX), and whether there were more */
function holestats_rows(PDO $db, $mask, $homeID) {
    return holestats_run($db, function () use ($db, $mask, $homeID) {
        $stmt = $db->prepare('SELECT id, wormholeID, homeSig, homeType, farSystemID, farSig, farType, firstSeen, lastUpdated, source, guessed
            FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ? ORDER BY firstSeen DESC, id DESC LIMIT ' . (HOLESTATS_READ_MAX + 1));
        $stmt->execute([$mask, (int) $homeID]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $capped = count($rows) > HOLESTATS_READ_MAX;
        $rows = array_slice($rows, 0, HOLESTATS_READ_MAX);
        foreach ($rows as &$r) {
            foreach (['id', 'wormholeID', 'farSystemID', 'guessed'] as $k) $r[$k] = (int) $r[$k];
        }
        unset($r);
        return ['rows' => $rows, 'capped' => $capped];
    });
}
