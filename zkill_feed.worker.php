<?php
// Fork-owned: Kill Reporting feed worker (see changes/ and docker/README.md#kill-reporting).
//
// Long-running CLI process (supervisord [program:zkill-feed]) that follows zKillboard's R2Z2 feed once
// for the whole instance and stores kills in systems that are on someone's chain in `zkill_kills`.
// Browsers never talk to zKillboard; they poll public/kills.php, which reads that table.
//
//   php zkill_feed.worker.php
//
// R2Z2 docs: https://zkillboard.com/api/docs/

if (php_sapi_name() !== 'cli') {
    http_response_code(404);
    exit();
}

// On a fatal error, pause before exiting so supervisord doesn't restart us in a tight loop
register_shutdown_function(function () {
    $error = error_get_last();
    if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) sleep(30);
});

chdir(__DIR__);
require('config.php');
date_default_timezone_set('UTC');

const ZKF_BASE_URL         = 'https://r2z2.zkillboard.com/ephemeral/';
const ZKF_CAUGHT_UP_SLEEP  = 6;        // seconds to wait after a 404 (feed caught up)
const ZKF_CATCHUP_DELAY_US = 250000;   // ~4 requests/s while catching up (R2Z2 allows 15/s)
const ZKF_BACKOFF_START    = 6;        // seconds, doubled on each consecutive error
const ZKF_BACKOFF_MAX      = 120;
const ZKF_RESUME_MAX_AGE   = 72000;    // 20 h: older stored sequences have expired on R2Z2
const ZKF_SYSTEMS_REFRESH  = 60;       // seconds between reloads of the chain system set
const ZKF_PRUNE_EVERY      = 600;      // seconds between prunes
const ZKF_KEEP_HOURS       = 24;
const ZKF_HEARTBEAT_EVERY  = 300;
const ZKF_STATE_SAVE_EVERY = 5;        // seconds; the sequence is also saved after every stored kill

// Same DDL as docker/sql/kill-reporting.sql (keep in sync)
const ZKF_DDL = [
    "CREATE TABLE IF NOT EXISTS `zkill_kills` (
      `id` bigint unsigned NOT NULL AUTO_INCREMENT,
      `killID` bigint unsigned NOT NULL,
      `systemID` int unsigned NOT NULL,
      `killTime` datetime NOT NULL,
      `receivedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      `victimCharacterID` bigint unsigned DEFAULT NULL,
      `victimCorporationID` bigint unsigned DEFAULT NULL,
      `victimAllianceID` bigint unsigned DEFAULT NULL,
      `victimShipTypeID` int unsigned DEFAULT NULL,
      `attackerCharacterCount` smallint unsigned NOT NULL DEFAULT 0,
      `attackerCorporationIDs` text NOT NULL,
      `finalBlowCharacterID` bigint unsigned DEFAULT NULL,
      `finalBlowShipTypeID` int unsigned DEFAULT NULL,
      `totalValue` decimal(20,2) NOT NULL DEFAULT 0,
      `solo` tinyint(1) NOT NULL DEFAULT 0,
      `hash` varchar(64) NOT NULL DEFAULT '',
      PRIMARY KEY (`id`),
      UNIQUE KEY `killID` (`killID`),
      KEY `receivedAt` (`receivedAt`),
      KEY `systemID` (`systemID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `zkill_feed_state` (
      `id` tinyint unsigned NOT NULL,
      `sequence` bigint unsigned NOT NULL,
      `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

function zkf_log($message) {
    fwrite(STDOUT, '[zkill-feed] ' . gmdate('Y-m-d H:i:s') . ' ' . $message . "\n");
}

function zkf_enabled() {
    if (defined('ZKILL_FEED_ENABLED')) return (bool) ZKILL_FEED_ENABLED;
    $value = getenv('ZKILL_FEED_ENABLED');
    if ($value === false || $value === '') return true;
    $parsed = filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $parsed === null ? true : $parsed;
}

function zkf_user_agent() {
    $agent = getenv('USER_AGENT');
    return ($agent === false || trim($agent) === '') ? 'Tripwire kill feed (+https://github.com/apettey/tripwire)' : $agent;
}

// Fresh connection from db.inc.php (included in function scope so it can be re-run after a drop)
function zkf_connect() {
    $mysql = null;
    include(__DIR__ . '/db.inc.php');
    if (!($mysql instanceof PDO)) throw new RuntimeException('could not connect to the database');
    $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $mysql->query('SELECT 1');
    foreach (ZKF_DDL as $ddl) $mysql->exec($ddl);
    return $mysql;
}

// GET a URL; returns [httpStatus, body]. Status 0 = network error.
function zkf_get($url) {
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERAGENT      => zkf_user_agent(),
        CURLOPT_ENCODING       => 'gzip',   // sends Accept-Encoding: gzip and decodes the response
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
    ]);
    $body = curl_exec($curl);
    $status = $body === false ? 0 : (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = $body === false ? curl_error($curl) : '';
    curl_close($curl);
    return [$status, $body === false ? $error : $body];
}

function zkf_latest_sequence() {
    [$status, $body] = zkf_get(ZKF_BASE_URL . 'sequence.json');
    if ($status !== 200) throw new RuntimeException("sequence.json: HTTP $status " . substr((string) $body, 0, 200));
    $data = json_decode($body, true);
    if (!isset($data['sequence']) || !is_numeric($data['sequence'])) throw new RuntimeException('sequence.json: unexpected body');
    return (int) $data['sequence'];
}

function zkf_load_sequence(PDO $db) {
    $row = $db->query('SELECT sequence, TIMESTAMPDIFF(SECOND, updatedAt, UTC_TIMESTAMP()) AS age FROM zkill_feed_state WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
    if ($row && (int) $row['age'] < ZKF_RESUME_MAX_AGE) {
        zkf_log('resuming at sequence ' . $row['sequence']);
        return (int) $row['sequence'];
    }
    $sequence = zkf_latest_sequence();
    zkf_log(($row ? 'stored sequence ' . $row['sequence'] . ' is too old' : 'no stored sequence') . ', starting at ' . $sequence);
    return $sequence;
}

function zkf_save_sequence(PDO $db, $sequence) {
    // updatedAt is written explicitly in UTC so the age check above doesn't depend on the session time zone
    $stmt = $db->prepare('INSERT INTO zkill_feed_state (id, sequence, updatedAt) VALUES (1, :seq, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE sequence = VALUES(sequence), updatedAt = VALUES(updatedAt)');
    $stmt->execute([':seq' => $sequence]);
}

// Systems on any chain: every system that has a signature (wormhole signatures sit on both ends of a
// connection, so this covers the connected systems too). J-space is always kept in zkf_wanted().
function zkf_chain_systems(PDO $db) {
    $ids = $db->query('SELECT DISTINCT systemID FROM signatures WHERE systemID IS NOT NULL AND systemID > 0')->fetchAll(PDO::FETCH_COLUMN);
    return array_fill_keys(array_map('intval', $ids), true);
}

function zkf_wanted($systemID, array $chainSystems) {
    return ($systemID >= 31000000 && $systemID <= 31999999) || isset($chainSystems[$systemID]);
}

// Returns true when the kill was stored (false: filtered out or already stored)
function zkf_store(PDO $db, array $kill, array $chainSystems) {
    $esi = $kill['esi'] ?? null;
    $zkb = $kill['zkb'] ?? [];
    if (!is_array($esi) || !isset($kill['killmail_id'], $esi['solar_system_id'], $esi['killmail_time'])) return false;
    if (!empty($zkb['npc'])) return false;
    $systemID = (int) $esi['solar_system_id'];
    if (!zkf_wanted($systemID, $chainSystems)) return false;

    $victim = $esi['victim'] ?? [];
    $attackers = is_array($esi['attackers'] ?? null) ? $esi['attackers'] : [];
    $characters = 0;
    $corporations = [];
    $finalBlow = null;
    foreach ($attackers as $attacker) {
        if (!empty($attacker['character_id'])) $characters++;
        if (!empty($attacker['corporation_id'])) $corporations[(int) $attacker['corporation_id']] = true;
        if (!empty($attacker['final_blow'])) $finalBlow = $attacker;
    }
    $killTime = strtotime($esi['killmail_time']);
    if ($killTime === false) return false;

    $stmt = $db->prepare('INSERT IGNORE INTO zkill_kills (killID, systemID, killTime, receivedAt, victimCharacterID,
            victimCorporationID, victimAllianceID, victimShipTypeID, attackerCharacterCount, attackerCorporationIDs,
            finalBlowCharacterID, finalBlowShipTypeID, totalValue, solo, hash)
        VALUES (:killID, :systemID, :killTime, UTC_TIMESTAMP(), :victimCharacterID, :victimCorporationID, :victimAllianceID,
            :victimShipTypeID, :attackerCharacterCount, :attackerCorporationIDs, :finalBlowCharacterID, :finalBlowShipTypeID,
            :totalValue, :solo, :hash)');
    $stmt->execute([
        ':killID'                 => (int) $kill['killmail_id'],
        ':systemID'               => $systemID,
        ':killTime'               => gmdate('Y-m-d H:i:s', $killTime),
        ':victimCharacterID'      => isset($victim['character_id']) ? (int) $victim['character_id'] : null,
        ':victimCorporationID'    => isset($victim['corporation_id']) ? (int) $victim['corporation_id'] : null,
        ':victimAllianceID'       => isset($victim['alliance_id']) ? (int) $victim['alliance_id'] : null,
        ':victimShipTypeID'       => isset($victim['ship_type_id']) ? (int) $victim['ship_type_id'] : null,
        ':attackerCharacterCount' => min($characters, 65535),
        ':attackerCorporationIDs' => implode(',', array_keys($corporations)),
        ':finalBlowCharacterID'   => isset($finalBlow['character_id']) ? (int) $finalBlow['character_id'] : null,
        ':finalBlowShipTypeID'    => isset($finalBlow['ship_type_id']) ? (int) $finalBlow['ship_type_id'] : null,
        ':totalValue'             => is_numeric($zkb['totalValue'] ?? null) ? round((float) $zkb['totalValue'], 2) : 0,
        ':solo'                   => !empty($zkb['solo']) ? 1 : 0,
        ':hash'                   => substr((string) ($kill['hash'] ?? ''), 0, 64),
    ]);
    if ($stmt->rowCount() < 1) return false;

    zkf_log(sprintf('stored kill %d in %d (%d pilots, %s ISK, ship %s, sequence %s)', $kill['killmail_id'], $systemID,
        $characters, number_format((float) ($zkb['totalValue'] ?? 0)), $victim['ship_type_id'] ?? '?', $kill['sequence_id'] ?? '?'));
    return true;
}

function zkf_prune(PDO $db) {
    $deleted = $db->exec('DELETE FROM zkill_kills WHERE receivedAt < UTC_TIMESTAMP() - INTERVAL ' . ZKF_KEEP_HOURS . ' HOUR');
    if ($deleted) zkf_log("pruned $deleted kills older than " . ZKF_KEEP_HOURS . ' h');
}

function zkf_run() {
    if (!zkf_enabled()) {
        zkf_log('ZKILL_FEED_ENABLED is off; idling');
        while (true) sleep(3600);
    }

    zkf_log('starting (user agent: ' . zkf_user_agent() . ')');
    $db = null;
    $sequence = null;
    $savedSequence = null;
    $lastSave = 0;
    $chainSystems = [];
    $systemsLoaded = 0;
    $lastPrune = 0;
    $lastHeartbeat = time();
    $stored = 0;
    $fetched = 0;
    $backoff = 0;
    $latestKnown = null;
    $latestChecked = 0;

    while (true) {
        try {
            if ($db === null) {
                $db = zkf_connect();
                $chainSystems = zkf_chain_systems($db);
                $systemsLoaded = time();
                zkf_log('connected to the database, ' . count($chainSystems) . ' chain systems');
            }
            if ($sequence === null) $sequence = zkf_load_sequence($db);

            $now = time();
            if ($now - $systemsLoaded >= ZKF_SYSTEMS_REFRESH) {
                $chainSystems = zkf_chain_systems($db);
                $systemsLoaded = $now;
            }
            if ($now - $lastPrune >= ZKF_PRUNE_EVERY) {
                zkf_prune($db);
                $lastPrune = $now;
            }
            if ($now - $lastHeartbeat >= ZKF_HEARTBEAT_EVERY) {
                zkf_log("heartbeat: sequence $sequence, fetched $fetched, stored $stored since start, " . count($chainSystems) . ' chain systems');
                $lastHeartbeat = $now;
            }

            [$status, $body] = zkf_get(ZKF_BASE_URL . $sequence . '.json');

            if ($status === 200) {
                $kill = json_decode($body, true);
                if (!is_array($kill)) throw new RuntimeException("sequence $sequence: invalid JSON");
                $fetched++;
                if (zkf_store($db, $kill, $chainSystems)) {
                    $stored++;
                    $lastSave = 0; // save right after the kill
                }
                $sequence++;
                $backoff = 0;
                if ($sequence !== $savedSequence && time() - $lastSave >= ZKF_STATE_SAVE_EVERY) {
                    zkf_save_sequence($db, $sequence);
                    $savedSequence = $sequence;
                    $lastSave = time();
                }
                usleep(ZKF_CATCHUP_DELAY_US);
                continue;
            }

            if ($status === 404) {
                $backoff = 0;
                if ($sequence !== $savedSequence) {
                    zkf_save_sequence($db, $sequence);
                    $savedSequence = $sequence;
                    $lastSave = time();
                }
                // A 404 normally means "caught up". If the feed's latest sequence is already past ours,
                // this one is a gap (or expired): skip it instead of waiting on it forever.
                if (time() - $latestChecked >= 60) {
                    $latestKnown = zkf_latest_sequence();
                    $latestChecked = time();
                }
                if ($latestKnown !== null && $sequence < $latestKnown) {
                    if ($latestKnown - $sequence > 200000) {
                        zkf_log("sequence $sequence is far behind the feed ($latestKnown), jumping ahead");
                        $sequence = $latestKnown;
                    } else {
                        zkf_log("sequence $sequence is missing (feed is at $latestKnown), skipping it");
                        $sequence++;
                    }
                    usleep(ZKF_CATCHUP_DELAY_US);
                    continue;
                }
                sleep(ZKF_CAUGHT_UP_SLEEP);
                continue;
            }

            throw new RuntimeException("sequence $sequence: HTTP $status " . substr(trim((string) $body), 0, 200));
        } catch (Throwable $error) {
            $backoff = $backoff ? min($backoff * 2, ZKF_BACKOFF_MAX) : ZKF_BACKOFF_START;
            zkf_log('error: ' . $error->getMessage() . "; retrying in {$backoff}s");
            if ($error instanceof PDOException) $db = null; // reconnect (long-running: the connection may have dropped)
            sleep($backoff);
        }
    }
}

zkf_run();
