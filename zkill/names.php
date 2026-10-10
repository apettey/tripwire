<?php
// Fork-owned: ESI name cache of the zKillboard integration (see zkill/zkill.inc.php).
//
// Endpoints call zk_names_lookup(): it returns the cached names and queues unknown IDs (a row with name NULL).
// The worker resolves the queue with zk_names_resolve() in batches through ESI POST /universe/names/.

const ZK_NAMES_BATCH        = 500;  // IDs per worker pass (ESI accepts up to 1000 per request)
const ZK_NAMES_MAX_REQUESTS = 6;    // ESI requests per pass (a 404 batch is split in halves to find the bad IDs)
const ZK_NAMES_TIMEOUT      = 10;   // seconds per request
const ZK_NAMES_MAX_ATTEMPTS = 5;

/**
 * Cached names for the given IDs; unknown IDs are queued for the worker.
 * @return array [names: id => name (only resolved, non-empty names), pending: number of IDs still queued]
 */
function zk_names_lookup(PDO $db, array $ids, $queue = true) {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids), function ($id) { return $id > 0; })));
    $names = [];
    $pending = 0;
    if (!$ids) return [$names, $pending];
    $known = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $stmt = $db->prepare('SELECT id, name FROM zkill_names WHERE id IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')');
        $stmt->execute($chunk);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $known[(int) $row['id']] = true;
            if ($row['name'] === null) $pending++;
            elseif ($row['name'] !== '') $names[(int) $row['id']] = $row['name'];
        }
    }
    $unknown = array_values(array_filter($ids, function ($id) use ($known) { return !isset($known[$id]); }));
    if ($unknown && $queue) {
        foreach (array_chunk($unknown, 500) as $chunk) {
            $stmt = $db->prepare('INSERT IGNORE INTO zkill_names (id, requestedAt) VALUES '
                . implode(',', array_fill(0, count($chunk), '(?, UTC_TIMESTAMP())')));
            $stmt->execute($chunk);
        }
    }
    return [$names, $pending + count($unknown)];
}

/**
 * Worker: resolve queued names with at most $maxRequests ESI requests. Returns the number of IDs resolved
 * (including unknown ones), or null if nothing was queued or ESI is rate limited.
 */
function zk_names_resolve(PDO $db, $maxRequests = ZK_NAMES_MAX_REQUESTS) {
    if (!zk_http_ready('esi.evetech.net')) return null;
    $ids = $db->query('SELECT id FROM zkill_names WHERE name IS NULL ORDER BY requestedAt LIMIT ' . ZK_NAMES_BATCH)->fetchAll(PDO::FETCH_COLUMN);
    if (!$ids) return null;
    $ids = array_map('intval', $ids);

    $found = [];      // id => [name, category]
    $invalid = [];    // ids ESI doesn't know
    $failed = [];     // ids whose request failed (network, 5xx, 420/429)
    $requests = 0;
    $batches = [$ids];
    while ($batches) {
        $batch = array_shift($batches);
        if ($requests >= $maxRequests || !zk_http_ready('esi.evetech.net')) continue;   // stays queued
        $requests++;
        [$status, $body] = zk_http_request('POST', ZK_ESI_BASE . 'universe/names', json_encode($batch), false, ZK_NAMES_TIMEOUT);
        $data = $status === 200 ? json_decode($body, true) : null;
        if (is_array($data)) {
            foreach ($data as $entry) {
                if (isset($entry['id'], $entry['name'])) $found[(int) $entry['id']] = [(string) $entry['name'], (string) ($entry['category'] ?? '')];
            }
            foreach ($batch as $id) if (!isset($found[$id])) $invalid[] = $id;
        } elseif ($status === 404 || $status === 400) {
            // At least one ID is not a valid name ID: split until the bad ones are isolated
            if (count($batch) === 1) $invalid[] = $batch[0];
            else { $half = (int) ceil(count($batch) / 2); $batches[] = array_slice($batch, 0, $half); $batches[] = array_slice($batch, $half); }
        } else {
            $failed = array_merge($failed, $batch);
        }
    }

    $resolve = $db->prepare('UPDATE zkill_names SET name = ?, category = ?, resolvedAt = UTC_TIMESTAMP() WHERE id = ?');
    foreach ($found as $id => [$name, $category]) $resolve->execute([mb_substr($name, 0, 255), substr($category, 0, 32), $id]);
    foreach ($invalid as $id) $resolve->execute(['', 'unknown', $id]);
    if ($failed) {
        $placeholders = implode(',', array_fill(0, count($failed), '?'));
        $db->prepare('UPDATE zkill_names SET attempts = attempts + 1 WHERE id IN (' . $placeholders . ')')->execute($failed);
        $db->prepare("UPDATE zkill_names SET name = '', category = 'failed', resolvedAt = UTC_TIMESTAMP()
            WHERE name IS NULL AND attempts >= " . ZK_NAMES_MAX_ATTEMPTS . ' AND id IN (' . $placeholders . ')')->execute($failed);
    }
    return count($found) + count($invalid);
}
