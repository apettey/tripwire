<?php
// Fork-owned: per-system back-fill of the zKillboard integration (see zkill/zkill.inc.php).
//
// The stream (R2Z2) stores every kill from the moment the worker started following it (stream.coveredSince).
// Anything older is fetched per system from the zKillboard API, but never in a web request: endpoints call
// zk_backfill_request(), which queues the system, and the worker drains the queue one system at a time with
// zk_backfill_run_one(), spaced by ZKILL_API_INTERVAL.

const ZK_BACKFILL_COOLDOWN   = 600;  // seconds before a system whose back-fill failed / no longer covers is queued again
const ZK_BACKFILL_ESI_MAX    = 100;  // killmails per job fetched from ESI when the API returns only id + hash
const ZK_BACKFILL_PAGE_FULL  = 150;  // an API answer this long may be truncated: coverage then starts at its oldest kill

/**
 * Start of the gap-free coverage (unix time) for one system, or null if nothing is covered up to now.
 * @param int|null $streamSince unix time since when the stream has stored every kill
 * @param array|null $backfill ['status' => .., 'completedAt' => unix|null, 'coveredFrom' => unix|null]
 */
function zk_coverage_from($streamSince, $backfill) {
    if ($streamSince === null) return null;
    $from = $streamSince;
    // A back-fill joins the stream's coverage when it ended after the stream (re)started
    if ($backfill && ($backfill['status'] ?? '') === 'done' && $backfill['coveredFrom'] !== null
        && $backfill['completedAt'] !== null && $backfill['completedAt'] >= $streamSince) {
        $from = min($from, $backfill['coveredFrom']);
    }
    return $from;
}

/**
 * What to do for a system whose window is not covered.
 * @param array|null $backfill its queue row: ['status', 'windowSeconds', 'attemptedAt' => unix|null, 'completedAt' => unix|null]
 * @return array ['queue' => (re)queue it now, 'pending' => a back-fill is under way, the caller should poll again]
 */
function zk_backfill_decision($backfill, $streamSince, $windowSeconds, $now) {
    if (!$backfill) return ['queue' => true, 'pending' => true];
    $status = $backfill['status'];
    if ($status === 'queued' || $status === 'running') {
        return ['queue' => $backfill['windowSeconds'] < $windowSeconds, 'pending' => true];   // widen the window
    }
    $recent = $backfill['attemptedAt'] !== null && $backfill['attemptedAt'] > $now - ZK_BACKFILL_COOLDOWN;
    if ($status === 'done') {
        if ($backfill['windowSeconds'] < $windowSeconds) return ['queue' => true, 'pending' => true];
        // Joined the stream but still short: zKillboard's answer was cut off (busy system); asking again won't help
        if ($streamSince !== null && $backfill['completedAt'] !== null && $backfill['completedAt'] >= $streamSince) {
            return ['queue' => false, 'pending' => false];
        }
    }
    // Failed, or the stream restarted after the back-fill (gap): retry after the cooldown
    return $recent ? ['queue' => false, 'pending' => false] : ['queue' => true, 'pending' => true];
}

/** Unix time of a 'Y-m-d H:i:s' UTC value, null for null */
function zk_unix($datetime) {
    return $datetime === null ? null : strtotime($datetime . ' UTC');
}

/**
 * Coverage of the window [now - windowSeconds, now] for each system, queueing a back-fill for systems that
 * are not covered (deduped per system, ZK_BACKFILL_COOLDOWN after a failed or outdated attempt).
 * @return array systemID => ['complete' => bool, 'coveredFrom' => unix|null, 'pending' => bool,
 *                            'status' => queue status|null, 'error' => string]
 */
function zk_backfill_request(PDO $db, array $systemIDs, $windowSeconds, $queue = true) {
    $now = time();
    $needFrom = $now - $windowSeconds;
    $streamSince = zk_unix(zk_stream_covered_since($db));
    $rows = [];
    if ($systemIDs) {
        $stmt = $db->prepare('SELECT systemID, windowSeconds, status, requestedAt, attemptedAt, completedAt, coveredFrom, error
            FROM zkill_backfill WHERE systemID IN (' . implode(',', array_fill(0, count($systemIDs), '?')) . ')');
        $stmt->execute(array_values($systemIDs));
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $rows[(int) $row['systemID']] = $row;
    }
    $enqueue = $db->prepare("INSERT INTO zkill_backfill (systemID, windowSeconds, status, requestedAt)
        VALUES (?, ?, 'queued', UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
            requestedAt = IF(status IN ('queued', 'running'), requestedAt, VALUES(requestedAt)),
            windowSeconds = IF(status IN ('queued', 'running'), GREATEST(windowSeconds, VALUES(windowSeconds)), VALUES(windowSeconds)),
            status = IF(status = 'running', status, 'queued')");

    $result = [];
    foreach ($systemIDs as $systemID) {
        $row = $rows[$systemID] ?? null;
        $backfill = $row ? [
            'status' => $row['status'],
            'completedAt' => zk_unix($row['completedAt']),
            'coveredFrom' => zk_unix($row['coveredFrom']),
        ] : null;
        $from = zk_coverage_from($streamSince, $backfill);
        $complete = $from !== null && $from <= $needFrom;
        $status = $row ? $row['status'] : null;
        $pending = false;
        if (!$complete && $queue) {
            $decision = zk_backfill_decision($row ? [
                'status' => $row['status'],
                'windowSeconds' => (int) $row['windowSeconds'],
                'attemptedAt' => zk_unix($row['attemptedAt']),
                'completedAt' => $backfill['completedAt'],
            ] : null, $streamSince, $windowSeconds, $now);
            if ($decision['queue']) {
                $enqueue->execute([$systemID, $windowSeconds]);
                if ($status !== 'running') $status = 'queued';
            }
            $pending = $decision['pending'];
        }
        $result[$systemID] = [
            'complete' => $complete,
            'coveredFrom' => $from,
            'pending' => $pending,
            'status' => $status,
            'error' => $row ? (string) $row['error'] : '',
        ];
    }
    return $result;
}

/** Worker: put jobs interrupted by a restart back in the queue */
function zk_backfill_recover(PDO $db) {
    $db->exec("UPDATE zkill_backfill SET status = 'queued' WHERE status = 'running'");
}

/** Record a job's outcome. A done job goes straight back in the queue if a longer window was requested meanwhile. */
function zk_backfill_finish(PDO $db, $systemID, $status, $window, $completedAt, $coveredFrom, $error) {
    $stmt = $db->prepare("UPDATE zkill_backfill SET status = IF(? = 'done' AND windowSeconds > ?, 'queued', ?),
        completedAt = COALESCE(?, completedAt), coveredFrom = COALESCE(?, coveredFrom), error = ? WHERE systemID = ?");
    $stmt->execute([$status, $window, $status, $completedAt, $coveredFrom, substr($error, 0, 255), $systemID]);
}

/**
 * Worker: run the oldest queued back-fill if the zKillboard API may be called now.
 * @return string|null log line, or null when nothing was done
 */
function zk_backfill_run_one(PDO $db) {
    if (!zk_http_ready('zkillboard.com')) return null;
    $job = $db->query("SELECT systemID, windowSeconds FROM zkill_backfill WHERE status = 'queued' ORDER BY requestedAt LIMIT 1")->fetch(PDO::FETCH_ASSOC);
    if (!$job) return null;
    $systemID = (int) $job['systemID'];
    $db->prepare("UPDATE zkill_backfill SET status = 'running', attemptedAt = UTC_TIMESTAMP(), attempts = attempts + 1 WHERE systemID = ?")
        ->execute([$systemID]);

    $window = min(max(3600, (int) $job['windowSeconds']), zk_retention_seconds());
    $pastSeconds = min(604800, (int) ceil($window / 3600) * 3600);
    $started = time();
    [$status, $body] = zk_http_get(ZK_API_BASE . 'systemID/' . $systemID . '/pastSeconds/' . $pastSeconds . '/', false);
    $list = $status === 200 ? json_decode($body, true) : null;
    if (!is_array($list)) {
        $error = $status === 200 ? 'zKillboard: invalid JSON' : ($status === -1 ? 'zKillboard: rate limited' : "zKillboard: HTTP $status");
        zk_backfill_finish($db, $systemID, $status === -1 ? 'queued' : 'failed', $window, null, null, $error);
        return "back-fill $systemID: $error";
    }

    $stored = 0;
    $oldest = null;
    $missing = [];   // ESI URL => zkb part, for entries without the killmail itself
    foreach ($list as $entry) {
        if (!is_array($entry)) continue;
        $row = zk_killmail_row($entry);
        if ($row !== null) {
            $time = zk_unix($row['killTime']);
            $oldest = $oldest === null ? $time : min($oldest, $time);
            if (zk_store_killmail($db, $entry, 'backfill')) $stored++;
        } elseif (isset($entry['killmail_id'], $entry['zkb']['hash']) && ctype_digit((string) $entry['killmail_id'])
            && ctype_xdigit((string) $entry['zkb']['hash']) && count($missing) < ZK_BACKFILL_ESI_MAX) {
            $missing[ZK_ESI_BASE . 'killmails/' . $entry['killmail_id'] . '/' . $entry['zkb']['hash'] . '/'] = $entry['zkb'];
        }
    }
    $failed = 0;
    if ($missing) {
        foreach (zk_http_get_many(array_keys($missing), 5) as $url => [$esiStatus, $esiBody]) {
            $killmail = $esiStatus === 200 ? json_decode($esiBody, true) : null;
            if (!is_array($killmail)) { $failed++; continue; }
            $killmail['zkb'] = $missing[$url];
            $row = zk_killmail_row($killmail);
            if ($row !== null) $oldest = $oldest === null ? zk_unix($row['killTime']) : min($oldest, zk_unix($row['killTime']));
            if (zk_store_killmail($db, $killmail, 'backfill')) $stored++;
        }
    }

    if ($failed) {
        zk_backfill_finish($db, $systemID, 'failed', $window, null, null, "ESI: $failed of " . count($missing) . ' killmails failed');
        return "back-fill $systemID: stored $stored, $failed killmails failed on ESI";
    }
    $coveredFrom = count($list) >= ZK_BACKFILL_PAGE_FULL && $oldest !== null ? $oldest : $started - $pastSeconds;
    zk_backfill_finish($db, $systemID, 'done', $pastSeconds, gmdate('Y-m-d H:i:s', $started), gmdate('Y-m-d H:i:s', $coveredFrom), '');
    return "back-fill $systemID: " . count($list) . " kills in the last {$pastSeconds}s, $stored new";
}
