<?php
// Fork-owned: owner resolution for structures (feature "Structures", spec phase 4, reports/Structures and timers spec.md).
//
// A structure's owner typed as text that the cache of the pilot lookups (fork_pilot_entities) does not know stays
// unresolved (fork_structures.ownerText). Web requests never call ESI: structures.php only queues the text in
// fork_structure_owner_lookups (structures_owner_queue). The zKillboard worker (zkill_feed.worker.php, next to
// intel_affiliation_run) resolves the queue in structures_owner_run(): ESI POST /universe/ids (names -> corporation /
// alliance IDs, through zkill/http.php: one User-Agent, ESI error limits, the shared budget helper intel_esi_take),
// then queues the entities for name and ticker with intel_queue_entities (filled by intel_entities_step of the same
// worker), and writes the result into the unresolved rows of every mask (structures_owner_apply). The next `list`
// shows the owner. ESI knows names, not tickers: a typed ticker the cache doesn't know stays as typed.

require_once(__DIR__ . '/structures.inc.php');

const STRUCTURES_OWNER_BATCH       = 100;   // names per /universe/ids request
const STRUCTURES_OWNER_QUEUE_MAX   = 500;   // queued names at most (a web request that would exceed it is not queued)
const STRUCTURES_OWNER_MAX_TRIES   = 3;
const STRUCTURES_OWNER_NONE_DAYS   = 7;     // a name ESI doesn't know is not asked again for this long

const STRUCTURES_OWNER_DDL = [
    'CREATE TABLE IF NOT EXISTS fork_structure_owner_lookups (
        name varchar(100) NOT NULL,
        status varchar(8) NOT NULL DEFAULT \'queued\',
        entityID bigint unsigned DEFAULT NULL,
        entityType varchar(12) DEFAULT NULL,
        entityName varchar(255) DEFAULT NULL,
        requestedAt datetime NOT NULL,
        resolvedAt datetime DEFAULT NULL,
        attempts smallint unsigned NOT NULL DEFAULT 0,
        PRIMARY KEY (name),
        KEY queue (status, requestedAt)
    ) DEFAULT CHARSET=utf8mb4',
];

function structures_owner_schema(PDO $db) {
    foreach (STRUCTURES_OWNER_DDL as $ddl) {
        if ($db->exec($ddl) === false) throw new PDOException('Could not create fork_structure_owner_lookups: ' . implode(' ', $db->errorInfo()));
    }
}

/**
 * Web side: queue an owner text for the worker. Returns false when it is not worth asking ESI (too short: a ticker
 * guess) or the queue is full; a name ESI already answered stays as it is (the answer is applied by the worker).
 */
function structures_owner_queue(PDO $db, $text) {
    $name = intel_clean_field($text, 100);
    if (mb_strlen($name, 'UTF-8') < 3) return false;
    $count = (int) $db->query("SELECT COUNT(*) FROM fork_structure_owner_lookups WHERE status = 'queued'")->fetchColumn();
    if ($count >= STRUCTURES_OWNER_QUEUE_MAX) return false;
    // New names are queued; a 'none' answer older than a week (or a failed one) is asked again; a 'done' / fresh 'none' one is kept
    $stmt = $db->prepare("INSERT INTO fork_structure_owner_lookups (name, status, requestedAt) VALUES (:n, 'queued', UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
            status = IF(status IN ('none', 'failed') AND requestedAt < UTC_TIMESTAMP() - INTERVAL " . (int) STRUCTURES_OWNER_NONE_DAYS . " DAY, 'queued', status),
            attempts = IF(status = 'queued', 0, attempts),
            requestedAt = IF(status = 'queued', UTC_TIMESTAMP(), requestedAt)");
    $stmt->bindValue(':n', $name);
    $stmt->execute();
    return true;
}

/** After an add / update: queue the owner text when it was stored unresolved ($changes from structures_changes). Never throws into the request. */
function structures_queue_owner_text(PDO $db, array $changes) {
    if (!isset($changes['ownerText']) || $changes['ownerText'] === null || $changes['ownerText'] === '' || ($changes['ownerID'] ?? null) !== null) return false;
    try {
        structures_owner_schema($db);
        return structures_owner_queue($db, $changes['ownerText']);
    } catch (PDOException $error) {
        error_log('structures: could not queue an owner lookup: ' . $error->getMessage());
        return false;
    }
}

/** Write resolved lookups into the unresolved rows of every mask, and fill tickers from the entity cache. @return int rows changed */
function structures_owner_apply(PDO $db) {
    $a = $db->exec("UPDATE fork_structures s INNER JOIN fork_structure_owner_lookups l ON l.status = 'done' AND l.name = s.ownerText
        SET s.ownerID = l.entityID, s.ownerType = l.entityType, s.ownerName = l.entityName, s.ownerText = NULL
        WHERE s.ownerID IS NULL AND s.ownerText IS NOT NULL");
    if ($a === false) throw new PDOException('Could not apply structure owners');
    $b = 0;
    try {
        $b = $db->exec("UPDATE fork_structures s INNER JOIN fork_pilot_entities e ON e.id = s.ownerID AND e.kind = s.ownerType AND e.status = 'done'
            SET s.ownerTicker = e.ticker
            WHERE s.ownerID IS NOT NULL AND (s.ownerTicker IS NULL OR s.ownerTicker = '') AND e.ticker IS NOT NULL AND e.ticker <> ''");
    } catch (PDOException $error) {
        if ((string) $error->getCode() !== '42S02') throw $error;   // no entity cache yet
    }
    if ($b === false) throw new PDOException('Could not fill structure owner tickers');
    return $a + $b;
}

/** Forget answered lookups nobody needs any more (no unresolved row with that text), and old 'none' answers */
function structures_owner_housekeeping(PDO $db) {
    $db->exec("DELETE l FROM fork_structure_owner_lookups l WHERE l.status IN ('done', 'none', 'failed') AND l.requestedAt < UTC_TIMESTAMP() - INTERVAL "
        . (int) STRUCTURES_OWNER_NONE_DAYS . " DAY AND NOT EXISTS (SELECT 1 FROM fork_structures s WHERE s.ownerText = l.name)");
}

/**
 * Worker: one pass. At most one /universe/ids request (STRUCTURES_OWNER_BATCH names) within $maxRequests, then the
 * results are applied. @return string|null a log line, or null when nothing was done
 */
function structures_owner_run(PDO $db, $maxRequests = 1) {
    static $schema = false, $housekept = 0;
    if (!$schema) { structures_owner_schema($db); $schema = true; }
    $now = time();
    if ($now - $housekept >= 3600) { $housekept = $now; structures_owner_housekeeping($db); }
    $applied = 0;
    $resolved = 0;
    $unknown = 0;
    $names = $db->query("SELECT name FROM fork_structure_owner_lookups WHERE status = 'queued' ORDER BY attempts, requestedAt, name LIMIT " . STRUCTURES_OWNER_BATCH)->fetchAll(PDO::FETCH_COLUMN);
    if ($names && zk_http_wait('esi.evetech.net') <= 1) {
        $budget = ['requests' => 0, 'max' => $maxRequests, 'until' => microtime(true) + INTEL_AFF_PASS_SECONDS];
        if (intel_esi_take($budget)) {
            [$status, $data] = intel_esi_post('universe/ids', $names);
            if ($data !== null) {
                $found = [];
                foreach (['corporations' => 'corporation', 'alliances' => 'alliance'] as $key => $type) {
                    foreach ((is_array($data[$key] ?? null) ? $data[$key] : []) as $entry) {
                        if (!is_array($entry) || !isset($entry['id'], $entry['name']) || !is_numeric($entry['id'])) continue;
                        $k = mb_strtolower((string) $entry['name'], 'UTF-8');
                        if (!isset($found[$k])) $found[$k] = [(int) $entry['id'], $type, mb_substr((string) $entry['name'], 0, 255)];   // a corporation wins over an alliance of the same name
                    }
                }
                $yes = $db->prepare("UPDATE fork_structure_owner_lookups SET status = 'done', entityID = ?, entityType = ?, entityName = ?, resolvedAt = UTC_TIMESTAMP(), attempts = 0 WHERE name = ?");
                $no = $db->prepare("UPDATE fork_structure_owner_lookups SET status = 'none', resolvedAt = UTC_TIMESTAMP(), requestedAt = UTC_TIMESTAMP() WHERE name = ?");
                $entities = [];
                foreach ($names as $name) {
                    $hit = $found[mb_strtolower($name, 'UTF-8')] ?? null;
                    if ($hit) { $yes->execute([$hit[0], $hit[1], $hit[2], $name]); $entities[$hit[0]] = $hit[1]; $resolved++; }
                    else { $no->execute([$name]); $unknown++; }
                }
                if ($entities) intel_queue_entities($db, $entities);   // name and ticker, resolved by intel_entities_step
            } elseif ($status >= 400 && $status < 500 && $status !== 420 && $status !== 429) {
                $in = implode(',', array_fill(0, count($names), '?'));
                $db->prepare("UPDATE fork_structure_owner_lookups SET attempts = attempts + 1, requestedAt = UTC_TIMESTAMP() WHERE name IN ($in)")->execute($names);
                $db->prepare("UPDATE fork_structure_owner_lookups SET status = 'failed' WHERE attempts >= " . STRUCTURES_OWNER_MAX_TRIES . " AND name IN ($in)")->execute($names);
            }
            // network error / 5xx / rate limit: everything stays queued, the HTTP client backs off
        }
    }
    $applied = structures_owner_apply($db);
    if (!$resolved && !$unknown && !$applied) return null;
    return sprintf('structure owners: %d names resolved, %d unknown, %d rows updated', $resolved, $unknown, $applied);
}
