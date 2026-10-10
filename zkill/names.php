<?php
// Fork-owned: ESI name cache of the zKillboard integration (see zkill/zkill.inc.php).
//
// Endpoints call zk_names_lookup(): it returns the cached names and queues unknown IDs (a row with name NULL).
// The worker resolves the queue with zk_names_resolve() through ESI POST /universe/names, which rejects a whole
// batch (404) if one ID in it is invalid. To find such IDs without burning ESI's error limit, `attempts` is a
// tier: 0 = new (asked in one batch of up to 500), 1 = was in a rejected big batch (asked in batches of 10),
// 2+ = was in a rejected small batch (asked one by one); an ID rejected on its own is stored as unresolvable
// (name '', category 'invalid'). At most one rejection per pass, after which name passes pause for
// ZK_NAMES_ERROR_PAUSE seconds, so a bad ID costs about three ESI errors and the queue always moves on.

const ZK_NAMES_BATCH         = 500;  // new IDs per request (ESI accepts up to 1000)
const ZK_NAMES_SUSPECT_BATCH = 10;   // IDs per request from a rejected big batch
const ZK_NAMES_MAX_REQUESTS  = 6;    // ESI requests per pass
const ZK_NAMES_TIMEOUT       = 10;   // seconds per request
const ZK_NAMES_ERROR_PAUSE   = 10;   // seconds without name passes after ESI rejected a batch

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

/** Unix time (float) until which name passes are paused; $set changes it */
function zk_names_paused_until($set = null) {
    static $until = 0.0;
    if ($set !== null) $until = (float) $set;
    return $until;
}

/**
 * Batches for one pass: new IDs as one batch, then IDs from rejected small batches one by one, then IDs from
 * rejected big batches in small batches. @param array $rows [[id, attempts], ...]
 */
function zk_names_batches(array $rows) {
    $fresh = [];
    $single = [];
    $small = [];
    foreach ($rows as [$id, $attempts]) {
        if ($attempts <= 0) $fresh[] = $id;
        elseif ($attempts >= 2) $single[] = [$id];
        else $small[] = $id;
    }
    $batches = $fresh ? [array_slice($fresh, 0, ZK_NAMES_BATCH)] : [];
    return array_merge($batches, $single, array_chunk($small, ZK_NAMES_SUSPECT_BATCH));
}

/**
 * Worker: resolve queued names with at most $maxRequests ESI requests. Returns the number of IDs resolved
 * (including unresolvable ones), or null if nothing was queued, ESI is paused or name passes are paused.
 */
function zk_names_resolve(PDO $db, $maxRequests = ZK_NAMES_MAX_REQUESTS) {
    if (microtime(true) < zk_names_paused_until() || zk_http_wait('esi.evetech.net') > 1) return null;
    $rows = [];
    foreach ($db->query('SELECT id FROM zkill_names WHERE name IS NULL AND attempts = 0 ORDER BY requestedAt, id LIMIT ' . ZK_NAMES_BATCH) as $row) {
        $rows[] = [(int) $row['id'], 0];
    }
    $suspects = $maxRequests * ZK_NAMES_SUSPECT_BATCH;
    foreach ($db->query('SELECT id, attempts FROM zkill_names WHERE name IS NULL AND attempts > 0 ORDER BY attempts DESC, requestedAt, id LIMIT ' . $suspects) as $row) {
        $rows[] = [(int) $row['id'], (int) $row['attempts']];
    }
    if (!$rows) return null;

    $resolve = $db->prepare('UPDATE zkill_names SET name = ?, category = ?, resolvedAt = UTC_TIMESTAMP() WHERE id = ?');
    $resolved = 0;
    $requests = 0;
    foreach (zk_names_batches($rows) as $batch) {
        if ($requests >= $maxRequests || zk_http_wait('esi.evetech.net') > 1) break;   // the rest stays queued
        $requests++;
        [$status, $body] = zk_http_request('POST', ZK_ESI_BASE . 'universe/names', json_encode($batch), true, ZK_NAMES_TIMEOUT);
        $data = $status === 200 ? json_decode($body, true) : null;
        if (is_array($data)) {
            $found = [];
            foreach ($data as $entry) {
                if (isset($entry['id'], $entry['name'])) $found[(int) $entry['id']] = [(string) $entry['name'], (string) ($entry['category'] ?? '')];
            }
            foreach ($batch as $id) {
                [$name, $category] = $found[$id] ?? ['', 'unknown'];
                $resolve->execute([mb_substr($name, 0, 255), substr($category, 0, 32), $id]);
                $resolved++;
            }
        } elseif ($status === 404 || $status === 400) {
            // Rejected: an ID on its own is unresolvable; a batch moves its IDs to the next (smaller) tier
            if (count($batch) === 1) {
                $resolve->execute(['', 'invalid', $batch[0]]);
                $resolved++;
            } else {
                $db->prepare('UPDATE zkill_names SET attempts = attempts + 1 WHERE id IN (' . implode(',', array_fill(0, count($batch), '?')) . ')')
                    ->execute($batch);
            }
            zk_names_paused_until(microtime(true) + ZK_NAMES_ERROR_PAUSE);
            break;
        } else {
            // network / 5xx / rate limit: the HTTP client backs off; everything stays queued
            if ($status === 200) zk_http_block('esi.evetech.net', 0, 'HTTP 200 without JSON from /universe/names');
            break;
        }
    }
    return $resolved;
}
