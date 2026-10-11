<?php
// Fork-owned: who is in local (feature "Local: corporations, alliances and threat", see docker/README.md#who-is-in-local).
//
// A shared local scan stores character names only (intel/intel.inc.php). This module turns them into corporations,
// alliances and a compact zKillboard threat summary, without any web request talking to ESI or zKillboard: like the
// zKillboard integration (zkill/), endpoints read cache tables and queue work, and only zkill_feed.worker.php makes
// the outgoing requests, through zkill/http.php (one User-Agent, per-host spacing, ESI error limits, 403 blocks).
//
//   fork_pilot_affiliation  name -> characterID -> corporation / alliance. Also the queue of the ESI steps.
//                           characterID NULL = not resolved yet, 0 = no such character.
//   fork_pilot_entities     corporation / alliance names and tickers (ESI GET /corporations/<id>, /alliances/<id>)
//   fork_intel_lookups      one row per shared local scan: once its names are resolved, the worker picks the pilots
//                           whose zKillboard stats it looks up (at most INTEL_THREAT_PER_SCAN new ones, not friendly)
//   fork_pilot_threat       compact zKillboard character stats, cached INTEL_THREAT_TTL; also that queue
//
// Worker steps (zkill_feed.worker.php, only while the feed is enabled and caught up):
//   intel_affiliation_run()   ESI: POST /universe/ids (names -> IDs, 500 per call), POST /characters/affiliation
//                             (up to 1000 IDs per call), GET /corporations/<id> and /alliances/<id> (name, ticker)
//   intel_lookups_run()       no HTTP: queue threat lookups for scans whose names are resolved
//   intel_threat_run_one()    zKillboard GET /api/stats/characterID/<id>/kills/, lowest priority of the zKillboard API
//                             queues (after back-fills and system stats), within the same ZKILL_API_INTERVAL budget
// INTEL_ZKILL_THREAT_ENABLED=false turns the zKillboard step off for the instance (nothing is queued or requested).

require_once(__DIR__ . '/../zkill/zkill.inc.php');

const INTEL_AFF_TTL           = 3600;     // seconds an affiliation stays fresh (ESI caches it for an hour)
const INTEL_AFF_UNKNOWN_TTL   = 3600;     // names ESI didn't know are deleted (asked again when seen) after an hour
const INTEL_AFF_RESOLVE_TTL   = 86400;    // name -> character ID is checked again after a day (renamed characters)
const INTEL_AFF_RETRY         = 600;      // seconds before a failed name is queued again
const INTEL_AFF_GIVE_UP       = 3600;     // queued names still unresolved after this long are marked failed
const INTEL_AFF_MAX_TIER      = 3;        // rejections before a name / ID counts as failed
const INTEL_AFF_MAX_QUEUED    = 20000;    // queued names overall above which nothing new is queued
const INTEL_AFF_MAX_PER_USER  = 6000;     // names one user may queue per hour (3 full local lists), well below the overall cap
const INTEL_AFF_IDS_BATCH     = 500;      // names per POST /universe/ids (ESI's limit)
const INTEL_AFF_BATCH         = 1000;     // IDs per POST /characters/affiliation (ESI's limit)
const INTEL_AFF_SUSPECT_BATCH = 25;       // IDs per request from a rejected batch
const INTEL_AFF_REQUESTS      = 8;        // ESI requests per worker pass
const INTEL_AFF_TIMEOUT       = 5;        // seconds per request
const INTEL_AFF_PASS_SECONDS  = 3;        // no new ESI request after this long in one pass (keeps the R2Z2 poll on time)
const INTEL_ENTITY_TTL        = 604800;   // corporation / alliance names and tickers are refreshed after a week
const INTEL_THREAT_TTL        = 86400;    // seconds a pilot's zKillboard stats stay fresh
const INTEL_THREAT_RETRY      = 3600;     // seconds before a failed stats lookup is queued again
const INTEL_THREAT_KEEP       = 172800;   // stats rows are deleted after this long
const INTEL_THREAT_PER_SCAN   = 20;       // new pilots looked up on zKillboard per local scan
const INTEL_THREAT_MAX_QUEUED = 300;      // queued stats lookups overall above which nothing new is queued
const INTEL_THREAT_MAX_PER_USER = 100;    // queued stats lookups one user's scans may have added
const INTEL_THREAT_TIMEOUT    = 10;
const INTEL_THREAT_SHIPS      = 3;        // top ship types kept per pilot
const INTEL_LOOKUP_WAIT       = 900;      // a scan waits at most this long for its names before threat lookups start
const INTEL_PILOTS_KEEP_DAYS  = 7;        // affiliation / entity rows nobody asked for in this many days are pruned
const INTEL_NPC_CORP_MIN      = 1000000;  // NPC corporations: 1000000-1999999
const INTEL_NPC_CORP_MAX      = 1999999;

const INTEL_PILOTS_DDL = [
    // Only names in EVE's character-name charset (ASCII, intel_lookup_name) are stored, so the case-insensitive
    // collation and PHP's strtolower() agree on what is the same name. resolvedAt: when name -> characterID was last
    // checked (NULL = to be checked by the next ID step)
    "CREATE TABLE IF NOT EXISTS `fork_pilot_affiliation` (
      `name` varchar(40) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
      `characterID` bigint unsigned DEFAULT NULL,
      `resolvedAt` datetime DEFAULT NULL,
      `corporationID` bigint unsigned DEFAULT NULL,
      `allianceID` bigint unsigned DEFAULT NULL,
      `status` varchar(8) NOT NULL DEFAULT 'queued',
      `requestedBy` int unsigned NOT NULL DEFAULT 0,
      `requestedAt` datetime NOT NULL,
      `wantedAt` datetime NOT NULL,
      `attemptedAt` datetime DEFAULT NULL,
      `fetchedAt` datetime DEFAULT NULL,
      `attempts` smallint unsigned NOT NULL DEFAULT 0,
      `error` varchar(255) NOT NULL DEFAULT '',
      PRIMARY KEY (`name`),
      KEY `queue` (`status`, `requestedAt`),
      KEY `requested_by` (`requestedBy`, `requestedAt`),
      KEY `character` (`characterID`),
      KEY `wanted` (`wantedAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_pilot_entities` (
      `id` bigint unsigned NOT NULL,
      `kind` varchar(12) NOT NULL,
      `name` varchar(255) DEFAULT NULL,
      `ticker` varchar(10) DEFAULT NULL,
      `status` varchar(8) NOT NULL DEFAULT 'queued',
      `requestedAt` datetime NOT NULL,
      `wantedAt` datetime NOT NULL,
      `fetchedAt` datetime DEFAULT NULL,
      `attempts` smallint unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`id`),
      KEY `queue` (`status`, `requestedAt`),
      KEY `wanted` (`wantedAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_intel_lookups` (
      `scanID` int unsigned NOT NULL,
      `status` varchar(8) NOT NULL DEFAULT 'pending',
      `requestedBy` int unsigned NOT NULL DEFAULT 0,
      `requestedAt` datetime NOT NULL,
      `friendlyCorporations` varchar(255) NOT NULL DEFAULT '',
      `friendlyAlliances` varchar(255) NOT NULL DEFAULT '',
      `threatQueued` smallint unsigned NOT NULL DEFAULT 0,
      `doneAt` datetime DEFAULT NULL,
      PRIMARY KEY (`scanID`),
      KEY `pending` (`status`, `requestedAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_pilot_threat` (
      `characterID` bigint unsigned NOT NULL,
      `status` varchar(8) NOT NULL DEFAULT 'queued',
      `requestedBy` int unsigned NOT NULL DEFAULT 0,
      `requestedAt` datetime NOT NULL,
      `attemptedAt` datetime DEFAULT NULL,
      `fetchedAt` datetime DEFAULT NULL,
      `attempts` smallint unsigned NOT NULL DEFAULT 0,
      `error` varchar(255) NOT NULL DEFAULT '',
      `data` text DEFAULT NULL,
      PRIMARY KEY (`characterID`),
      KEY `queue` (`status`, `requestedAt`),
      KEY `requested_by` (`requestedBy`, `status`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

function intel_pilots_schema(PDO $db) {
    foreach (INTEL_PILOTS_DDL as $ddl) {
        if ($db->exec($ddl) === false) throw new PDOException('Could not create the pilot tables: ' . implode(' ', $db->errorInfo()));
    }
}

/** Whether the worker looks pilots up at all (it only runs its queues while the zKillboard feed is enabled) */
function intel_pilots_lookups_enabled() {
    return zk_feed_enabled();
}

/** Whether the zKillboard step runs (INTEL_ZKILL_THREAT_ENABLED, default on; never without the feed) */
function intel_threat_enabled() {
    if (!intel_pilots_lookups_enabled()) return false;
    if (defined('INTEL_ZKILL_THREAT_ENABLED')) return (bool) INTEL_ZKILL_THREAT_ENABLED;
    $value = getenv('INTEL_ZKILL_THREAT_ENABLED');
    if ($value === false || $value === '') return true;
    $parsed = filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $parsed === null ? true : $parsed;
}

function intel_is_npc_corp($corporationID) {
    return $corporationID !== null && $corporationID >= INTEL_NPC_CORP_MIN && $corporationID <= INTEL_NPC_CORP_MAX;
}

/**
 * Whether a name can be an EVE character name worth looking up: 3-37 characters of ASCII letters, digits, space and
 * ' . - _ (EVE's charset; older names have . and _). Anything else (full-width or accented letters, ...) can't be a
 * character, so it counts as unknown without a lookup. Keeping the table ASCII-only also makes the column's
 * case-insensitive collation and intel_name_key() agree.
 */
function intel_lookup_name($name) {
    return is_string($name) && preg_match("/^[A-Za-z0-9][A-Za-z0-9 '._-]{2,36}(?<! )$/D", $name) === 1;
}

/** Lower-case key of a name (the table compares names ignoring case; only ASCII names are stored) */
function intel_name_key($name) {
    return intel_lookup_name($name) ? strtolower($name) : mb_strtolower((string) $name, 'UTF-8');
}

/**
 * Friendly corporations / alliances for a session and mask: the user's own, plus the mask's owner when the mask is a
 * corporation (".2") or alliance (".3") mask. @return array ['corporations' => int[], 'alliances' => int[]]
 */
function intel_friendly_ids(array $session, $mask) {
    $corporations = [];
    $alliances = [];
    if (!empty($session['corporationID']) && (int) $session['corporationID'] > 0) $corporations[] = (int) $session['corporationID'];
    if (!empty($session['allianceID']) && (int) $session['allianceID'] > 0) $alliances[] = (int) $session['allianceID'];
    $parts = explode('.', (string) $mask);
    if (count($parts) === 2 && ctype_digit($parts[0]) && (int) $parts[0] > 0) {
        if ($parts[1] === '2') $corporations[] = (int) $parts[0];
        if ($parts[1] === '3') $alliances[] = (int) $parts[0];
    }
    return ['corporations' => array_values(array_unique($corporations)), 'alliances' => array_values(array_unique($alliances))];
}

/**
 * Whether to (re)queue a name.
 * @param array|null $row ['status', 'characterID' => int|null, 'corporationID' => int|null, 'fetchedAt' => unix|null, 'attemptedAt' => unix|null]
 * @return array ['queue' => queue it now, 'pending' => no usable data yet and the worker is (or will be) on it]
 */
function intel_affiliation_decision($row, $now) {
    if (!$row) return ['queue' => true, 'pending' => true];
    $known = $row['characterID'] !== null && $row['characterID'] > 0 && $row['corporationID'] !== null;
    if ($row['status'] === 'queued') return ['queue' => false, 'pending' => !$known];
    if ($row['status'] === 'failed') {
        $retry = $row['attemptedAt'] === null || $row['attemptedAt'] <= $now - INTEL_AFF_RETRY;
        return ['queue' => $retry, 'pending' => $retry && !$known];
    }
    // done: affiliations are refreshed after an hour (kept on show meanwhile); unknown names are pruned after
    // INTEL_AFF_UNKNOWN_TTL and asked again the next time they are seen
    $ttl = $row['characterID'] === 0 ? INTEL_AFF_UNKNOWN_TTL : INTEL_AFF_TTL;
    $stale = $row['fetchedAt'] === null || $row['fetchedAt'] <= $now - $ttl;
    return ['queue' => $stale, 'pending' => false];
}

/**
 * How many of $count names may be queued now. $queued: queued names overall; $recentByUser: names this user queued in
 * the last hour (any status), so a user can't fill the table with names that resolve within seconds. The per-user
 * cap is far below the overall one, so one user can't keep the queue full for everyone else.
 */
function intel_affiliation_room($queued, $recentByUser, $userID, $count) {
    $room = INTEL_AFF_MAX_QUEUED - $queued;
    if ($userID > 0) $room = min($room, INTEL_AFF_MAX_PER_USER - $recentByUser);
    return max(0, min($count, $room));
}

/**
 * Cached affiliations of the names (scan order kept), queueing missing and stale names for the worker unless
 * $queue is false. Names outside EVE's charset (intel_lookup_name) are unknown without a lookup.
 * @return array ['rows' => key => row|null, 'pending' => names without data the worker is on,
 * 'queued' => names queued now, 'queueFull' => some names could not be queued]
 */
function intel_affiliation_request(PDO $db, array $names, $userID, $queue = true) {
    $now = time();
    $rows = [];
    $lookup = array_values(array_filter($names, 'intel_lookup_name'));
    foreach (array_chunk($lookup, 500) as $chunk) {
        $stmt = $db->prepare('SELECT name, characterID, corporationID, allianceID, status, fetchedAt, attemptedAt
            FROM fork_pilot_affiliation WHERE name IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')');
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rows[intel_name_key($row['name'])] = [
                'status' => $row['status'],
                'characterID' => $row['characterID'] === null ? null : (int) $row['characterID'],
                'corporationID' => $row['corporationID'] === null ? null : (int) $row['corporationID'],
                'allianceID' => $row['allianceID'] === null ? null : (int) $row['allianceID'],
                'fetchedAt' => zk_unix($row['fetchedAt']),
                'attemptedAt' => zk_unix($row['attemptedAt']),
            ];
        }
    }
    $out = [];
    $toQueue = [];
    $pendingKeys = [];
    foreach ($names as $name) {
        $key = intel_name_key($name);
        if (!intel_lookup_name($name)) {
            // Can't be a character name: unknown, never queued
            $out[$key] = ['status' => 'done', 'characterID' => 0, 'corporationID' => null, 'allianceID' => null, 'fetchedAt' => $now, 'attemptedAt' => null];
            continue;
        }
        $row = $rows[$key] ?? null;
        $decision = intel_affiliation_decision($row, $now);
        if ($queue && $decision['queue']) $toQueue[$key] = $name;
        $out[$key] = $row;
        // Read only: pending means the worker already has it queued
        $known = $row && $row['characterID'] !== null && $row['characterID'] > 0 && $row['corporationID'] !== null;
        if ($queue ? $decision['pending'] : ($row && $row['status'] === 'queued' && !$known)) $pendingKeys[$key] = true;
    }
    $queueFull = false;
    $queuedNow = 0;
    if ($toQueue) {
        $queued = (int) $db->query("SELECT COUNT(*) FROM fork_pilot_affiliation WHERE status = 'queued'")->fetchColumn();
        $byUser = $db->prepare('SELECT COUNT(*) FROM fork_pilot_affiliation WHERE requestedBy = ? AND requestedAt > ?');
        $byUser->execute([(int) $userID, gmdate('Y-m-d H:i:s', $now - 3600)]);
        $room = intel_affiliation_room($queued, (int) $byUser->fetchColumn(), (int) $userID, count($toQueue));
        if ($room < count($toQueue)) {
            $queueFull = true;
            foreach (array_slice(array_keys($toQueue), $room) as $key) unset($pendingKeys[$key]);   // the worker won't get to these
            $toQueue = array_slice($toQueue, 0, $room, true);
        }
        // An unknown name is resolved again from scratch; a known character needs its affiliation again, and its
        // name -> ID mapping too once that is older than INTEL_AFF_RESOLVE_TTL (renamed characters)
        foreach (array_chunk(array_values($toQueue), 500) as $chunk) {
            $values = implode(',', array_fill(0, count($chunk), "(?, 'queued', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())"));
            $params = [];
            foreach ($chunk as $name) { $params[] = $name; $params[] = (int) $userID; }
            $db->prepare("INSERT INTO fork_pilot_affiliation (name, status, requestedBy, requestedAt, wantedAt) VALUES $values
                ON DUPLICATE KEY UPDATE status = 'queued', attempts = 0, error = '', requestedBy = VALUES(requestedBy),
                    requestedAt = VALUES(requestedAt), wantedAt = VALUES(wantedAt),
                    resolvedAt = IF(resolvedAt < UTC_TIMESTAMP() - INTERVAL " . INTEL_AFF_RESOLVE_TTL . " SECOND, NULL, resolvedAt),
                    characterID = IF(characterID = 0, NULL, characterID)")->execute($params);
            $queuedNow += count($chunk);
        }
        foreach (array_keys($toQueue) as $key) {
            if ($out[$key]) $out[$key]['status'] = 'queued';
        }
    }
    // Remember that someone still wants the rest (pruning keeps rows asked for in the last INTEL_PILOTS_KEEP_DAYS)
    if ($queue) {
        $known = array_values(array_filter($lookup, function ($name) use ($rows, $toQueue) {
            $key = intel_name_key($name);
            return isset($rows[$key]) && !isset($toQueue[$key]);
        }));
        foreach (array_chunk($known, 500) as $chunk) {
            $db->prepare('UPDATE fork_pilot_affiliation SET wantedAt = UTC_TIMESTAMP() WHERE name IN ('
                . implode(',', array_fill(0, count($chunk), '?')) . ') AND wantedAt < UTC_TIMESTAMP() - INTERVAL 1 HOUR')->execute($chunk);
        }
    }
    return ['rows' => $out, 'pending' => count($pendingKeys), 'queued' => $queuedNow, 'queueFull' => $queueFull];
}

/** Character names of one of the mask's unexpired local scans in the system, or null when there is no such scan */
function intel_scan_names(PDO $db, $mask, $systemID, $scanID) {
    $stmt = $db->prepare("SELECT data FROM fork_intel_scans WHERE id = :id AND maskID = :mask AND systemID = :systemID
        AND kind = 'local' AND expiresAt > UTC_TIMESTAMP()");
    $stmt->bindValue(':id', (int) $scanID, PDO::PARAM_INT);
    $stmt->bindValue(':mask', $mask);
    $stmt->bindValue(':systemID', (int) $systemID, PDO::PARAM_INT);
    if (!$stmt->execute()) throw new PDOException('Could not read fork_intel_scans');
    $data = $stmt->fetchColumn();
    if ($data === false) return null;
    $data = json_decode($data, true);
    return is_array($data) && is_array($data['names'] ?? null) ? array_values(array_map('strval', $data['names'])) : [];
}

/** Names and tickers of corporations / alliances: id => [name, ticker] (only fetched ones) */
function intel_entities(PDO $db, array $ids) {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids), function ($id) { return $id > 0; })));
    $out = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $stmt = $db->prepare('SELECT id, name, ticker FROM fork_pilot_entities WHERE name IS NOT NULL AND id IN ('
            . implode(',', array_fill(0, count($chunk), '?')) . ')');
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $out[(string) (int) $row['id']] = [(string) $row['name'], (string) $row['ticker']];
    }
    return $out;
}

/** Threat rows of characters: id => ['status', 'fetchedAt' => unix|null, 'data' => compact|null] */
function intel_threat_rows(PDO $db, array $characterIDs) {
    $ids = array_values(array_unique(array_filter(array_map('intval', $characterIDs), function ($id) { return $id > 0; })));
    $out = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $stmt = $db->prepare('SELECT characterID, status, fetchedAt, data FROM fork_pilot_threat WHERE characterID IN ('
            . implode(',', array_fill(0, count($chunk), '?')) . ')');
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $data = $row['data'] !== null && $row['data'] !== '' ? json_decode($row['data'], true) : null;
            $out[(int) $row['characterID']] = ['status' => $row['status'], 'fetchedAt' => zk_unix($row['fetchedAt']), 'data' => is_array($data) ? $data : null];
        }
    }
    return $out;
}

/**
 * Web: queue a freshly shared local scan (its names, and a lookup job that later picks the threat lookups).
 * Does nothing while the worker doesn't run its queues. @return array|null the affiliation request's result
 */
function intel_pilots_on_share(PDO $db, $scanID, array $names, $userID, array $friendly) {
    if (!intel_pilots_lookups_enabled() || !$names) return null;
    intel_pilots_schema($db);
    $result = intel_affiliation_request($db, $names, $userID, true);
    $stmt = $db->prepare("INSERT IGNORE INTO fork_intel_lookups (scanID, status, requestedBy, requestedAt, friendlyCorporations, friendlyAlliances)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, ?)");
    $stmt->execute([(int) $scanID, intel_threat_enabled() ? 'pending' : 'done', (int) $userID,
        substr(implode(',', $friendly['corporations']), 0, 255), substr(implode(',', $friendly['alliances']), 0, 255)]);
    return $result;
}

/**
 * Web: everything the browser needs to group a local scan's pilots. Pilots come back in the scan's name order as
 * [characterID (null = not resolved yet, 0 = unknown), corporationID, allianceID, threat], threat being null (not
 * looked up), 'q' (queued), 'f' (failed) or the compact stats.
 */
function intel_pilots_view(PDO $db, $scanID, array $names, $userID, array $friendly) {
    intel_pilots_schema($db);
    $lookups = intel_pilots_lookups_enabled();
    $affiliation = intel_affiliation_request($db, $names, $userID, $lookups);
    $characterIDs = [];
    $entityIDs = [];
    foreach ($affiliation['rows'] as $row) {
        if (!$row) continue;
        if ($row['characterID']) $characterIDs[] = $row['characterID'];
        if ($row['corporationID']) $entityIDs[] = $row['corporationID'];
        if ($row['allianceID']) $entityIDs[] = $row['allianceID'];
    }
    $threat = intel_threat_rows($db, $characterIDs);
    $job = $db->prepare('SELECT status FROM fork_intel_lookups WHERE scanID = ?');
    $job->execute([(int) $scanID]);
    $jobStatus = $job->fetchColumn();
    $pilots = [];
    foreach ($names as $name) {
        $row = $affiliation['rows'][intel_name_key($name)] ?? null;
        $characterID = $row ? $row['characterID'] : null;
        $corporationID = $row ? $row['corporationID'] : null;
        if ($row && $row['status'] === 'failed' && $corporationID === null) $characterID = 0;   // given up: unknown
        $entry = $characterID ? ($threat[$characterID] ?? null) : null;
        $state = null;
        if ($entry) {
            if ($entry['data'] !== null) $state = $entry['data'];
            elseif ($entry['status'] === 'queued' || $entry['status'] === 'running') $state = 'q';
            elseif ($entry['status'] === 'failed') $state = 'f';
        }
        $pilots[] = [$characterID, $corporationID, $row ? $row['allianceID'] : null, $state];
    }
    $threatOn = intel_threat_enabled();
    return [
        'scanID' => (int) $scanID,
        'lookups' => $lookups,
        'threat' => $threatOn,
        'pending' => $lookups ? $affiliation['pending'] : 0,
        'queueFull' => $affiliation['queueFull'],
        'threatPending' => $threatOn && $jobStatus === 'pending',
        'friendly' => $friendly,
        'pilots' => $pilots,
        'entities' => (object) intel_entities($db, $entityIDs),
    ];
}

// ---- Worker ----

/** Worker: requeue / give up / prune (every minute; pruning hourly) */
function intel_pilots_housekeeping(PDO $db, $now, $prune) {
    $db->prepare("UPDATE fork_pilot_affiliation SET status = 'failed', error = 'gave up', attemptedAt = UTC_TIMESTAMP()
        WHERE status = 'queued' AND requestedAt < ?")->execute([gmdate('Y-m-d H:i:s', $now - INTEL_AFF_GIVE_UP)]);
    $db->prepare("UPDATE fork_pilot_entities SET status = 'failed' WHERE status = 'queued' AND requestedAt < ?")
        ->execute([gmdate('Y-m-d H:i:s', $now - INTEL_AFF_GIVE_UP)]);
    $db->prepare("UPDATE fork_pilot_threat SET status = 'queued' WHERE status = 'running' AND attemptedAt < ?")
        ->execute([gmdate('Y-m-d H:i:s', $now - 300)]);
    // Names ESI didn't know (typos, random text) go soon: they are asked again if anyone pastes them again
    $db->prepare("DELETE FROM fork_pilot_affiliation WHERE characterID = 0 AND status = 'done' AND fetchedAt < ?")
        ->execute([gmdate('Y-m-d H:i:s', $now - INTEL_AFF_UNKNOWN_TTL)]);
    if (!$prune) return;
    $keep = gmdate('Y-m-d H:i:s', $now - INTEL_PILOTS_KEEP_DAYS * 86400);
    $db->prepare('DELETE FROM fork_pilot_affiliation WHERE wantedAt < ?')->execute([$keep]);
    $db->prepare('DELETE FROM fork_pilot_entities WHERE wantedAt < ?')->execute([$keep]);
    $db->prepare("DELETE FROM fork_pilot_threat WHERE status <> 'running' AND requestedAt < ? AND (fetchedAt IS NULL OR fetchedAt < ?)")
        ->execute([gmdate('Y-m-d H:i:s', $now - INTEL_THREAT_KEEP), gmdate('Y-m-d H:i:s', $now - INTEL_THREAT_KEEP)]);
    // Scans live 24 hours (INTEL_RETENTION_H); their lookup jobs an hour longer
    $db->prepare('DELETE FROM fork_intel_lookups WHERE requestedAt < ?')->execute([gmdate('Y-m-d H:i:s', $now - 25 * 3600)]);
}

/** POST JSON to ESI through the pooled client. @return array [status, decoded value or null] */
function intel_esi_post($route, array $body) {
    [$status, $raw] = zk_http_request('POST', ZK_ESI_BASE . $route, json_encode(array_values($body)), true, INTEL_AFF_TIMEOUT);
    $data = $status === 200 ? json_decode((string) $raw, true) : null;
    if ($status === 200 && !is_array($data)) zk_http_block('esi.evetech.net', 0, "HTTP 200 without JSON from /$route");
    return [$status, is_array($data) ? $data : null];
}

/**
 * Batches for the tiered retry used by both ESI steps (like zkill/names.php): new rows (tier 0) in one big batch,
 * rows from a rejected big batch (tier 1) in small batches, rows from a rejected small batch (tier 2+) one by one.
 * @param array $rows [[key, tier], ...]
 */
function intel_tier_batches(array $rows, $big) {
    $fresh = [];
    $small = [];
    $single = [];
    foreach ($rows as [$key, $tier]) {
        if ($tier <= 0) $fresh[] = $key;
        elseif ($tier === 1) $small[] = $key;
        else $single[] = [$key];
    }
    return array_merge($fresh ? [array_slice($fresh, 0, $big)] : [], $single, array_chunk($small, INTEL_AFF_SUSPECT_BATCH));
}

/**
 * Worker: one pass of the ESI steps with at most $maxRequests requests: names -> IDs, IDs -> affiliation, then
 * corporation / alliance names and tickers. @return string|null log line, or null when nothing was done
 */
function intel_affiliation_run(PDO $db, $maxRequests = INTEL_AFF_REQUESTS) {
    static $housekept = 0, $pruned = 0;
    $now = time();
    if ($now - $housekept >= 60) {
        $prune = $now - $pruned >= 3600;
        intel_pilots_housekeeping($db, $now, $prune);
        $housekept = $now;
        if ($prune) $pruned = $now;
    }
    if (zk_http_wait('esi.evetech.net') > 1) return null;
    $budget = ['requests' => 0, 'max' => $maxRequests, 'until' => microtime(true) + INTEL_AFF_PASS_SECONDS];
    $done = ['ids' => 0, 'unknown' => 0, 'affiliations' => 0, 'entities' => 0];
    $rejected = false;
    intel_ids_step($db, $budget, $done, $rejected);
    if (!$rejected) intel_affiliation_step($db, $budget, $done, $rejected);
    if (!$rejected) intel_entities_step($db, $budget, $done);
    if (!$budget['requests']) return null;
    return sprintf('local pilots: %d names resolved (%d unknown), %d affiliations, %d corporations/alliances in %d ESI requests',
        $done['ids'], $done['unknown'], $done['affiliations'], $done['entities'], $budget['requests']);
}

/**
 * May the pass send another ESI request? Counts it if so. Not after INTEL_AFF_PASS_SECONDS: the pass runs between R2Z2
 * polls, so it may overrun that by at most one request (INTEL_AFF_TIMEOUT).
 */
function intel_esi_take(array &$budget) {
    if ($budget['requests'] >= $budget['max'] || zk_http_wait('esi.evetech.net') > 1) return false;
    if (isset($budget['until']) && microtime(true) >= $budget['until']) return false;
    $budget['requests']++;
    return true;
}

/**
 * Names -> character IDs (POST /universe/ids): new names, and known ones whose mapping is due again (resolvedAt NULL,
 * see intel_affiliation_request). Names ESI doesn't know (any more: renamed) become characterID 0 (unknown).
 */
function intel_ids_step(PDO $db, array &$budget, array &$done, &$rejected) {
    $rows = [];
    foreach ($db->query("SELECT name, attempts FROM fork_pilot_affiliation WHERE status = 'queued' AND (characterID IS NULL OR resolvedAt IS NULL)
        ORDER BY attempts, requestedAt, name LIMIT " . INTEL_AFF_IDS_BATCH) as $row) {
        $rows[] = [$row['name'], (int) $row['attempts']];
    }
    if (!$rows) return;
    $resolved = $db->prepare("UPDATE fork_pilot_affiliation SET characterID = ?, resolvedAt = UTC_TIMESTAMP(), attempts = 0, attemptedAt = UTC_TIMESTAMP() WHERE name = ?");
    $unknown = $db->prepare("UPDATE fork_pilot_affiliation SET characterID = 0, resolvedAt = UTC_TIMESTAMP(), corporationID = NULL, allianceID = NULL, status = 'done',
        attempts = 0, error = '', attemptedAt = UTC_TIMESTAMP(), fetchedAt = UTC_TIMESTAMP() WHERE name = ?");
    foreach (intel_tier_batches($rows, INTEL_AFF_IDS_BATCH) as $batch) {
        if (!intel_esi_take($budget)) return;
        [$status, $data] = intel_esi_post('universe/ids', $batch);
        if ($data !== null) {
            $ids = [];
            foreach ((is_array($data['characters'] ?? null) ? $data['characters'] : []) as $entry) {
                if (isset($entry['id'], $entry['name']) && is_numeric($entry['id'])) $ids[intel_name_key($entry['name'])] = (int) $entry['id'];
            }
            foreach ($batch as $name) {
                $id = $ids[intel_name_key($name)] ?? 0;
                if ($id > 0) { $resolved->execute([$id, $name]); $done['ids']++; }
                else { $unknown->execute([$name]); $done['unknown']++; }
            }
        } elseif ($status >= 400 && $status < 500 && $status !== 420 && $status !== 429) {
            intel_reject($db, 'fork_pilot_affiliation', 'name', $batch, "ESI /universe/ids: HTTP $status");
            $rejected = true;
            return;
        } else {
            return;   // network / 5xx / rate limit: the HTTP client backs off, everything stays queued
        }
    }
}

/** IDs -> corporation / alliance (POST /characters/affiliation); queues the corporations and alliances for names */
function intel_affiliation_step(PDO $db, array &$budget, array &$done, &$rejected) {
    $rows = [];
    $names = [];
    foreach ($db->query("SELECT name, characterID, attempts FROM fork_pilot_affiliation WHERE status = 'queued' AND characterID > 0
        AND resolvedAt IS NOT NULL ORDER BY attempts, requestedAt, characterID LIMIT " . INTEL_AFF_BATCH) as $row) {
        $id = (int) $row['characterID'];
        if (!isset($names[$id])) $rows[] = [$id, (int) $row['attempts']];
        $names[$id][] = $row['name'];
    }
    if (!$rows) return;
    $update = $db->prepare("UPDATE fork_pilot_affiliation SET corporationID = ?, allianceID = ?, status = 'done', attempts = 0, error = '',
        attemptedAt = UTC_TIMESTAMP(), fetchedAt = UTC_TIMESTAMP() WHERE name = ?");
    foreach (intel_tier_batches($rows, INTEL_AFF_BATCH) as $batch) {
        if (!intel_esi_take($budget)) return;
        [$status, $data] = intel_esi_post('characters/affiliation', $batch);
        if ($data !== null) {
            $found = [];
            foreach ($data as $entry) {
                if (!is_array($entry) || !is_numeric($entry['character_id'] ?? null) || !is_numeric($entry['corporation_id'] ?? null)) continue;
                $found[(int) $entry['character_id']] = [(int) $entry['corporation_id'], is_numeric($entry['alliance_id'] ?? null) ? (int) $entry['alliance_id'] : null];
            }
            $entities = [];
            foreach ($batch as $id) {
                [$corporationID, $allianceID] = $found[$id] ?? [null, null];
                foreach ($names[$id] as $name) $update->execute([$corporationID, $allianceID, $name]);
                $done['affiliations']++;
                if ($corporationID && !intel_is_npc_corp($corporationID)) $entities[$corporationID] = 'corporation';
                if ($allianceID) $entities[$allianceID] = 'alliance';
            }
            intel_queue_entities($db, $entities);
        } elseif ($status >= 400 && $status < 500 && $status !== 420 && $status !== 429) {
            $batchNames = [];
            foreach ($batch as $id) foreach ($names[$id] as $name) $batchNames[] = $name;
            intel_reject($db, 'fork_pilot_affiliation', 'name', $batchNames, "ESI /characters/affiliation: HTTP $status", count($batch) === 1);
            $rejected = true;
            return;
        } else {
            return;
        }
    }
}

/**
 * A batch ESI rejected: its rows go to the next (smaller) tier; a row rejected on its own, or past the last tier,
 * is marked failed. One rejection per pass (the caller stops), so a bad row costs about three ESI errors.
 */
function intel_reject(PDO $db, $table, $key, array $batch, $error, $single = null) {
    $single = $single === null ? count($batch) === 1 : $single;
    $in = implode(',', array_fill(0, count($batch), '?'));
    if ($single) {
        $db->prepare("UPDATE $table SET status = 'failed', error = ?, attemptedAt = UTC_TIMESTAMP() WHERE $key IN ($in)")
            ->execute(array_merge([substr($error, 0, 255)], $batch));
        return;
    }
    $db->prepare("UPDATE $table SET attempts = attempts + 1, error = ?, attemptedAt = UTC_TIMESTAMP() WHERE $key IN ($in)")
        ->execute(array_merge([substr($error, 0, 255)], $batch));
    $db->prepare("UPDATE $table SET status = 'failed' WHERE attempts >= " . INTEL_AFF_MAX_TIER . " AND $key IN ($in)")->execute($batch);
}

/** Queue corporations / alliances (id => kind) whose name and ticker are missing or older than INTEL_ENTITY_TTL */
function intel_queue_entities(PDO $db, array $entities) {
    if (!$entities) return;
    // Refresh stale names and tickers, and retry failed lookups after a day. A separate UPDATE evaluates the condition
    // once on the old values (in ON DUPLICATE KEY UPDATE, later assignments see the columns earlier ones changed)
    $again = "((status = 'done' AND fetchedAt < UTC_TIMESTAMP() - INTERVAL " . INTEL_ENTITY_TTL . " SECOND)
        OR (status = 'failed' AND requestedAt < UTC_TIMESTAMP() - INTERVAL 1 DAY))";
    foreach (array_chunk($entities, 500, true) as $chunk) {
        $ids = array_map('intval', array_keys($chunk));
        $db->prepare("UPDATE fork_pilot_entities SET status = 'queued', attempts = 0, requestedAt = UTC_TIMESTAMP()
            WHERE id IN (" . implode(',', array_fill(0, count($ids), '?')) . ") AND $again")->execute($ids);
        $values = implode(',', array_fill(0, count($chunk), "(?, ?, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())"));
        $params = [];
        foreach ($chunk as $id => $kind) { $params[] = (int) $id; $params[] = $kind; }
        $db->prepare("INSERT INTO fork_pilot_entities (id, kind, status, requestedAt, wantedAt) VALUES $values
            ON DUPLICATE KEY UPDATE wantedAt = VALUES(wantedAt)")->execute($params);
    }
}

/** Corporation / alliance names and tickers (GET /corporations/<id>, /alliances/<id>), one request each */
function intel_entities_step(PDO $db, array &$budget, array &$done) {
    $left = $budget['max'] - $budget['requests'];
    if ($left <= 0) return;
    $jobs = $db->query("SELECT id, kind FROM fork_pilot_entities WHERE status = 'queued' ORDER BY requestedAt, id LIMIT " . (int) $left)->fetchAll(PDO::FETCH_ASSOC);
    $store = $db->prepare("UPDATE fork_pilot_entities SET name = ?, ticker = ?, status = 'done', attempts = 0, fetchedAt = UTC_TIMESTAMP() WHERE id = ?");
    $fail = $db->prepare("UPDATE fork_pilot_entities SET attempts = attempts + 1,
        status = IF(attempts >= " . INTEL_AFF_MAX_TIER . ", 'failed', status) WHERE id = ?");
    foreach ($jobs as $job) {
        if (!intel_esi_take($budget)) return;
        $id = (int) $job['id'];
        $route = ($job['kind'] === 'alliance' ? 'alliances/' : 'corporations/') . $id;
        [$status, $data] = zk_http_get_json(ZK_ESI_BASE . $route, true, INTEL_AFF_TIMEOUT);
        if ($status === 200 && is_array($data) && isset($data['name'])) {
            $store->execute([mb_substr((string) $data['name'], 0, 255), mb_substr((string) ($data['ticker'] ?? ''), 0, 10), $id]);
            $done['entities']++;
        } elseif ($status >= 400 && $status < 500 && $status !== 420 && $status !== 429) {
            $fail->execute([$id]);
            return;   // one ESI error per pass
        } else {
            return;
        }
    }
}

/**
 * Pick the pilots of a scan whose zKillboard stats to look up: not friendly, those in player corporations before
 * those in NPC corporations, paste order otherwise; only pilots without fresh or queued stats; at most $limit.
 * @param array $pilots [[characterID, corporationID, allianceID], ...] in paste order
 * @param array $threat characterID => ['status', 'fetchedAt' => unix|null]
 */
function intel_threat_pick(array $pilots, array $friendly, array $threat, $now, $limit = INTEL_THREAT_PER_SCAN) {
    $friendlyCorps = array_flip($friendly['corporations'] ?? []);
    $friendlyAlliances = array_flip($friendly['alliances'] ?? []);
    $players = [];
    $npc = [];
    $seen = [];
    foreach ($pilots as [$characterID, $corporationID, $allianceID]) {
        if (!$characterID || $characterID <= 0 || isset($seen[$characterID])) continue;
        $seen[$characterID] = true;
        if ($corporationID !== null && isset($friendlyCorps[$corporationID])) continue;
        if ($allianceID !== null && isset($friendlyAlliances[$allianceID])) continue;
        $row = $threat[$characterID] ?? null;
        if ($row) {
            if ($row['status'] === 'queued' || $row['status'] === 'running') continue;
            if ($row['status'] === 'done' && $row['fetchedAt'] !== null && $row['fetchedAt'] > $now - INTEL_THREAT_TTL) continue;
            if ($row['status'] === 'failed' && ($row['attemptedAt'] ?? null) !== null && $row['attemptedAt'] > $now - INTEL_THREAT_RETRY) continue;
        }
        if (intel_is_npc_corp($corporationID)) $npc[] = $characterID; else $players[] = $characterID;
    }
    return array_slice(array_merge($players, $npc), 0, $limit);
}

/** How many of $count threat lookups may be queued now (overall and per-user caps) */
function intel_threat_room($queued, $queuedByUser, $userID, $count) {
    $room = INTEL_THREAT_MAX_QUEUED - $queued;
    if ($userID > 0) $room = min($room, INTEL_THREAT_MAX_PER_USER - $queuedByUser);
    return max(0, min($count, $room));
}

/**
 * Worker (no HTTP): for scans whose names are resolved (or that waited INTEL_LOOKUP_WAIT), queue the threat lookups.
 * @return string|null log line
 */
function intel_lookups_run(PDO $db, $maxJobs = 5) {
    $jobs = $db->query("SELECT scanID, requestedBy, friendlyCorporations, friendlyAlliances, TIMESTAMPDIFF(SECOND, requestedAt, UTC_TIMESTAMP()) AS age
        FROM fork_intel_lookups WHERE status = 'pending' ORDER BY requestedAt LIMIT " . (int) $maxJobs)->fetchAll(PDO::FETCH_ASSOC);
    if (!$jobs) return null;
    $finish = $db->prepare("UPDATE fork_intel_lookups SET status = 'done', threatQueued = ?, doneAt = UTC_TIMESTAMP() WHERE scanID = ?");
    $lines = [];
    $now = time();
    foreach ($jobs as $job) {
        $scanID = (int) $job['scanID'];
        if (!intel_threat_enabled()) { $finish->execute([0, $scanID]); continue; }
        $scan = $db->prepare("SELECT data FROM fork_intel_scans WHERE id = ? AND kind = 'local' AND expiresAt > UTC_TIMESTAMP()");
        $scan->execute([$scanID]);
        $data = json_decode((string) $scan->fetchColumn(), true);
        $names = is_array($data) && is_array($data['names'] ?? null) ? array_map('strval', $data['names']) : [];
        if (!$names) { $finish->execute([0, $scanID]); continue; }
        $affiliation = intel_affiliation_request($db, $names, (int) $job['requestedBy'], false);
        if ($affiliation['pending'] > 0 && (int) $job['age'] < INTEL_LOOKUP_WAIT) continue;   // names not resolved yet
        $pilots = [];
        $ids = [];
        foreach ($affiliation['rows'] as $row) {
            if (!$row || !$row['characterID'] || $row['corporationID'] === null) continue;
            $pilots[] = [$row['characterID'], $row['corporationID'], $row['allianceID']];
            $ids[] = $row['characterID'];
        }
        $threat = [];
        foreach (array_chunk(array_values(array_unique($ids)), 500) as $chunk) {
            $stmt = $db->prepare('SELECT characterID, status, fetchedAt, attemptedAt FROM fork_pilot_threat WHERE characterID IN ('
                . implode(',', array_fill(0, count($chunk), '?')) . ')');
            $stmt->execute($chunk);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $threat[(int) $row['characterID']] = ['status' => $row['status'], 'fetchedAt' => zk_unix($row['fetchedAt']), 'attemptedAt' => zk_unix($row['attemptedAt'])];
            }
        }
        $friendly = [
            'corporations' => array_map('intval', array_filter(explode(',', $job['friendlyCorporations']))),
            'alliances' => array_map('intval', array_filter(explode(',', $job['friendlyAlliances']))),
        ];
        $pick = intel_threat_pick($pilots, $friendly, $threat, $now);
        $queued = (int) $db->query("SELECT COUNT(*) FROM fork_pilot_threat WHERE status IN ('queued', 'running')")->fetchColumn();
        $byUser = $db->prepare("SELECT COUNT(*) FROM fork_pilot_threat WHERE requestedBy = ? AND status IN ('queued', 'running')");
        $byUser->execute([(int) $job['requestedBy']]);
        $pick = array_slice($pick, 0, intel_threat_room($queued, (int) $byUser->fetchColumn(), (int) $job['requestedBy'], count($pick)));
        if ($pick) {
            $values = implode(',', array_fill(0, count($pick), "(?, 'queued', ?, UTC_TIMESTAMP())"));
            $params = [];
            foreach ($pick as $id) { $params[] = $id; $params[] = (int) $job['requestedBy']; }
            $db->prepare("INSERT INTO fork_pilot_threat (characterID, status, requestedBy, requestedAt) VALUES $values
                ON DUPLICATE KEY UPDATE status = IF(status = 'running', status, 'queued'), requestedBy = VALUES(requestedBy),
                    requestedAt = VALUES(requestedAt), attempts = 0, error = ''")->execute($params);
        }
        $finish->execute([count($pick), $scanID]);
        $lines[] = "scan $scanID: " . count($pick) . ' pilots queued for zKillboard stats';
    }
    return $lines ? 'local threat: ' . implode('; ', $lines) : null;
}

/**
 * Compact threat summary from a zKillboard character stats answer (intel_threat_url()),
 * or null when it isn't one. A character without any kills or losses comes back with zeros.
 *   danger (dangerRatio, %), gang (gangRatio, %), kills (shipsDestroyed), losses (shipsLost), solo (soloKills),
 *   kills7d (activepvp), lastMonth ('YYYY-MM' of the newest month with kills), ships ([[typeID, name, kills]], the
 *   7-day top ship types, at most INTEL_THREAT_SHIPS; the browser derives cyno-capable hulls from types.json)
 */
function intel_threat_compact($data) {
    if (!is_array($data) || isset($data['error'])) return null;
    $int = function ($value) { return is_numeric($value) ? max(0, (int) $value) : 0; };
    $lastMonth = null;
    $lastKey = 0;
    foreach ((is_array($data['months'] ?? null) ? $data['months'] : []) as $month) {
        if (!is_array($month) || !is_numeric($month['year'] ?? null) || !is_numeric($month['month'] ?? null)) continue;
        if (!is_numeric($month['shipsDestroyed'] ?? null) || (int) $month['shipsDestroyed'] <= 0) continue;
        $key = (int) $month['year'] * 100 + (int) $month['month'];
        if ($key > $lastKey) { $lastKey = $key; $lastMonth = sprintf('%04d-%02d', (int) $month['year'], (int) $month['month']); }
    }
    $ships = [];
    foreach ((is_array($data['topLists'] ?? null) ? $data['topLists'] : []) as $list) {
        if (!is_array($list) || ($list['type'] ?? '') !== 'shipType' || !is_array($list['values'] ?? null)) continue;
        foreach ($list['values'] as $value) {
            if (count($ships) >= INTEL_THREAT_SHIPS || !is_array($value)) break;
            $typeID = is_numeric($value['shipTypeID'] ?? null) ? (int) $value['shipTypeID'] : (is_numeric($value['id'] ?? null) ? (int) $value['id'] : 0);
            if ($typeID <= 0) continue;
            $ships[] = [$typeID, mb_substr((string) ($value['shipName'] ?? ($value['name'] ?? '')), 0, 100), $int($value['kills'] ?? 0)];
        }
    }
    $kills7d = is_array($data['activepvp']['kills'] ?? null) ? $int($data['activepvp']['kills']['count'] ?? 0) : 0;
    return [
        'danger' => is_numeric($data['dangerRatio'] ?? null) ? max(0, min(100, (int) $data['dangerRatio'])) : null,
        'gang' => is_numeric($data['gangRatio'] ?? null) ? max(0, min(100, (int) $data['gangRatio'])) : null,
        'kills' => $int($data['shipsDestroyed'] ?? 0),
        'losses' => $int($data['shipsLost'] ?? 0),
        'solo' => $int($data['soloKills'] ?? 0),
        'kills7d' => $kills7d,
        'lastMonth' => $lastMonth,
        'ships' => $ships,
    ];
}

/**
 * zKillboard's character stats route. With the sort segment ("kills/"): without it zKillboard answers with a redirect
 * to this URL (zKillboard source, view/apistats.php).
 */
function intel_threat_url($characterID) {
    return ZK_API_BASE . 'stats/characterID/' . (int) $characterID . '/kills/';
}

/**
 * Interpret an answer of the character stats route. @return array [compact stats or null, error text, block the host]
 *   - JSON stats object: compact stats
 *   - an empty body, `null`, `[]` or `{}`: no stats, cached as zeros (never a reason to block zKillboard)
 *   - {"error": "Invalid type or id"}: zKillboard has no record of the character (never killed or lost anything): zeros
 *   - any other {"error": ...} (e.g. "entity is disqualified"): failed, retried after INTEL_THREAT_RETRY
 *   - HTTP 200 that is not JSON (Cloudflare challenge, maintenance page): failed and block, like zk_http_get_json()
 *   - other statuses: failed (the HTTP client has already backed off / blocked as needed)
 */
function intel_threat_answer($status, $body) {
    if ($status !== 200) return [null, "zKillboard: HTTP $status", false];
    $text = trim((string) $body);
    if ($text === '' || $text === 'null' || $text === '[]' || $text === '{}') return [intel_threat_compact([]), '', false];
    $data = json_decode($text, true);
    if (!is_array($data)) {
        return [null, 'HTTP 200 without JSON: ' . substr(preg_replace('/\s+/', ' ', strip_tags($text)), 0, 80), true];
    }
    if (isset($data['error'])) {
        if ((string) $data['error'] === 'Invalid type or id') return [intel_threat_compact([]), '', false];
        return [null, 'zKillboard: ' . substr((string) $data['error'], 0, 200), false];
    }
    $threat = intel_threat_compact($data);
    return $threat === null ? [null, 'zKillboard: unexpected answer', false] : [$threat, '', false];
}

/**
 * Worker: one pilot's zKillboard stats, the lowest priority of the zKillboard API work: only when the API may be
 * called now (ZKILL_API_INTERVAL, backoff, blocks) and no back-fill or system stats are queued.
 * @return string|null log line, or null when nothing was done
 */
function intel_threat_run_one(PDO $db) {
    if (!intel_threat_enabled() || !zk_http_ready('zkillboard.com')) return null;
    if ($db->query("SELECT 1 FROM zkill_backfill WHERE status = 'queued' LIMIT 1")->fetchColumn()) return null;
    if ($db->query("SELECT 1 FROM zkill_system_stats WHERE status = 'queued' LIMIT 1")->fetchColumn()) return null;
    $job = $db->query("SELECT characterID FROM fork_pilot_threat WHERE status = 'queued' ORDER BY requestedAt, characterID LIMIT 1")->fetchColumn();
    if ($job === false) return null;
    $characterID = (int) $job;
    $db->prepare("UPDATE fork_pilot_threat SET status = 'running', attemptedAt = UTC_TIMESTAMP(), attempts = attempts + 1 WHERE characterID = ?")
        ->execute([$characterID]);
    $finish = $db->prepare('UPDATE fork_pilot_threat SET status = ?, error = ?, data = COALESCE(?, data),
        fetchedAt = CASE WHEN ? IS NULL THEN fetchedAt ELSE UTC_TIMESTAMP() END WHERE characterID = ?');
    try {
        // Not zk_http_get_json(): an empty answer must not block zKillboard (see intel_threat_answer)
        [$status, $body] = zk_http_get(intel_threat_url($characterID), false, INTEL_THREAT_TIMEOUT);
        if ($status === -1) {
            $finish->execute(['queued', '', null, null, $characterID]);
            return null;
        }
        [$threat, $error, $block] = intel_threat_answer($status, $body);
        if ($block) zk_http_block('zkillboard.com', 0, $error);
        if ($threat === null) {
            $finish->execute(['failed', substr($error, 0, 255), null, null, $characterID]);
            return "pilot stats $characterID: $error";
        }
        $json = json_encode($threat);
        $finish->execute(['done', '', $json, $json, $characterID]);
        return "pilot stats $characterID: danger " . ($threat['danger'] ?? '-') . "%, {$threat['kills']} kills";
    } catch (Throwable $error) {
        try {
            $finish->execute(['failed', substr('error: ' . $error->getMessage(), 0, 255), null, null, $characterID]);
        } catch (Throwable $ignored) {
            // the database is gone; housekeeping re-queues the running row later
        }
        if ($error instanceof PDOException) throw $error;
        return "pilot stats $characterID failed: " . $error->getMessage();
    }
}

/**
 * Worker: one zKillboard API job in priority order: back-fills (open panels), system stats (System Threat), then
 * pilot stats (local threat). At most one request per call, within ZKILL_API_INTERVAL.
 */
function intel_zkill_api_step(PDO $db) {
    $line = zk_backfill_run_one($db);
    if ($line === null) $line = zk_stats_run_one($db);
    if ($line === null) $line = intel_threat_run_one($db);
    return $line;
}
