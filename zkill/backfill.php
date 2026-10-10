<?php
// Fork-owned: per-system back-fill of the zKillboard integration (see zkill/zkill.inc.php).
//
// The stream (R2Z2) stores every kill from the moment the worker started following it (stream.coveredSince) up to
// its high-water mark. Anything older is fetched per system from the zKillboard API, but never in a web request:
// endpoints call zk_backfill_request(), which queues the system (bounded: valid systems only, ZK_BACKFILL_MAX_QUEUED
// overall per source, ZK_BACKFILL_MAX_PER_USER per user), and the worker drains the queue one system at a time with
// zk_backfill_run_one() while the stream is caught up, highest priority first, spaced by ZKILL_API_INTERVAL.

const ZK_BACKFILL_PRIORITY      = ['panel' => 10, 'chain' => 20];   // request source => queue priority
const ZK_BACKFILL_COOLDOWN      = 600;   // seconds before a failed / outdated back-fill is queued again
// Queued + running rows (all sources) above which a source queues nothing new: panel clicks may fill the queue to
// 800, the remaining 200 are reserved for chain back-fills
const ZK_BACKFILL_MAX_QUEUED    = ['panel' => 800, 'chain' => 1000];
// Queued + running rows one user may have added (all sources) above which a source queues nothing new for them
const ZK_BACKFILL_MAX_PER_USER  = ['panel' => 250, 'chain' => 500];
const ZK_BACKFILL_STALE_RUNNING = 300;   // seconds after which a 'running' job counts as abandoned
const ZK_BACKFILL_TIMEOUT       = 10;    // seconds per HTTP request of a job
const ZK_BACKFILL_BUDGET        = 8;     // seconds a job may spend on ESI killmail fetches
const ZK_BACKFILL_ESI_MAX       = 200;   // killmails per job fetched from ESI (>= the API's page size)
const ZK_BACKFILL_PAGE_FULL     = 150;   // an API answer this long may be truncated: coverage then starts at its oldest kill
const ZK_STREAM_LAG_TOLERANCE   = 120;   // seconds the high-water mark may trail now and still count as caught up

/**
 * Start of the gap-free coverage (unix time) for one system, or null if nothing is covered.
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
 * What to do for a system whose history (start of the window) is not covered.
 * @param array|null $backfill its queue row: ['status', 'windowSeconds', 'priority', 'attemptedAt' => unix|null, 'completedAt' => unix|null]
 * @return array ['queue' => (re)queue / upgrade it now, 'pending' => a back-fill is under way, poll again]
 */
function zk_backfill_decision($backfill, $streamSince, $windowSeconds, $now, $priority = 10) {
    if (!$backfill) return ['queue' => true, 'pending' => true];
    $status = $backfill['status'];
    if ($status === 'queued' || $status === 'running') {
        // widen the window or raise the priority of a queued job
        $upgrade = $backfill['windowSeconds'] < $windowSeconds || ($backfill['priority'] ?? 0) < $priority;
        return ['queue' => $upgrade, 'pending' => true];
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

/**
 * Whether a new queue entry may be added.
 * @param int $queued queued + running rows overall; @param int $queuedByUser of them added by this user
 */
function zk_backfill_admit($queued, $queuedByUser, $source, $userID) {
    $global = ZK_BACKFILL_MAX_QUEUED[$source] ?? ZK_BACKFILL_MAX_QUEUED['panel'];
    $perUser = ZK_BACKFILL_MAX_PER_USER[$source] ?? ZK_BACKFILL_MAX_PER_USER['panel'];
    return $queued < $global && ($userID <= 0 || $queuedByUser < $perUser);
}

/**
 * Where a back-fill's coverage starts (unix time).
 * @param int $started when the job asked zKillboard
 * @param int $pastSeconds the window it asked for
 * @param int $listCount entries zKillboard returned
 * @param array $entries killID => kill time (unix) of each returned entry, null for one that was not stored
 *                       (ESI cap, budget, failure)
 */
function zk_backfill_covered_from($started, $pastSeconds, $listCount, array $entries) {
    // Newest kill first by killID (doesn't rely on zKillboard's order): everything before the first gap is complete
    krsort($entries);
    $gap = in_array(null, $entries, true);
    $oldest = null;
    foreach ($entries as $time) {
        if ($time === null) break;
        $oldest = $oldest === null ? $time : min($oldest, $time);
    }
    if ($gap) return $oldest ?? $started;
    if ($listCount >= ZK_BACKFILL_PAGE_FULL) return $oldest ?? $started;
    return $started - $pastSeconds;
}

/**
 * Coverage of the window [now - windowSeconds, now] for each system, queueing a back-fill for systems whose history
 * is not covered (see zk_backfill_decision()), unless the queue limits are reached.
 * @param array $options queue (bool), source ('panel'|'chain'), userID (int)
 * @return array systemID => ['complete' => bool, 'coveredFrom' => unix|null, 'coveredTo' => unix|null, 'pending' => bool,
 *                            'queueFull' => bool, 'status' => queue status|null, 'error' => string]
 */
function zk_backfill_request(PDO $db, array $systemIDs, $windowSeconds, array $options = []) {
    $queue = $options['queue'] ?? true;
    $source = isset(ZK_BACKFILL_PRIORITY[$options['source'] ?? '']) ? $options['source'] : 'panel';
    $priority = ZK_BACKFILL_PRIORITY[$source];
    $userID = (int) ($options['userID'] ?? 0);
    $now = time();
    $needFrom = $now - $windowSeconds;
    [$streamSince, $highWater] = zk_stream_window($db);
    $rows = [];
    if ($systemIDs) {
        $stmt = $db->prepare('SELECT systemID, windowSeconds, status, priority, requestedAt, attemptedAt, completedAt, coveredFrom, error
            FROM zkill_backfill WHERE systemID IN (' . implode(',', array_fill(0, count($systemIDs), '?')) . ')');
        $stmt->execute(array_values($systemIDs));
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $rows[(int) $row['systemID']] = $row;
    }
    $queued = null;
    $queuedByUser = null;
    $enqueue = $db->prepare("INSERT INTO zkill_backfill (systemID, windowSeconds, status, priority, requestedBy, requestedAt)
        VALUES (?, ?, 'queued', ?, ?, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
            requestedAt = IF(status IN ('queued', 'running'), requestedAt, VALUES(requestedAt)),
            requestedBy = IF(status IN ('queued', 'running'), requestedBy, VALUES(requestedBy)),
            priority = IF(status IN ('queued', 'running'), GREATEST(priority, VALUES(priority)), VALUES(priority)),
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
        $historyCovered = $from !== null && $from <= $needFrom;
        $complete = $historyCovered && $highWater !== null && $highWater >= $now - ZK_STREAM_LAG_TOLERANCE;
        $status = $row ? $row['status'] : null;
        $pending = false;
        $queueFull = false;
        if (!$historyCovered && $queue) {
            $decision = zk_backfill_decision($row ? [
                'status' => $row['status'],
                'windowSeconds' => (int) $row['windowSeconds'],
                'priority' => (int) $row['priority'],
                'attemptedAt' => zk_unix($row['attemptedAt']),
                'completedAt' => $backfill['completedAt'],
            ] : null, $streamSince, $windowSeconds, $now, $priority);
            $inQueue = $row && in_array($row['status'], ['queued', 'running'], true);
            if ($decision['queue'] && !$inQueue) {
                // A new queue entry: respect the global and per-user limits
                if ($queued === null) {
                    $queued = (int) $db->query("SELECT COUNT(*) FROM zkill_backfill WHERE status IN ('queued', 'running')")->fetchColumn();
                    $byUser = $db->prepare("SELECT COUNT(*) FROM zkill_backfill WHERE requestedBy = ? AND status IN ('queued', 'running')");
                    $byUser->execute([$userID]);
                    $queuedByUser = (int) $byUser->fetchColumn();
                }
                if (!zk_backfill_admit($queued, $queuedByUser, $source, $userID)) {
                    $queueFull = true;
                    $decision = ['queue' => false, 'pending' => false];
                } else {
                    $queued++;
                    $queuedByUser++;
                }
            }
            if ($decision['queue']) {
                $enqueue->execute([$systemID, $windowSeconds, $priority, $userID]);
                if ($status !== 'running') $status = 'queued';
            }
            $pending = $decision['pending'];
        }
        $result[$systemID] = [
            'complete' => $complete,
            'coveredFrom' => $from,
            'coveredTo' => $from === null ? null : $highWater,
            'pending' => $pending,
            'queueFull' => $queueFull,
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
 * Worker: run the most important queued back-fill if the zKillboard API may be called now. Any error marks the
 * job failed (database errors are re-thrown after that so the worker reconnects).
 * @return string|null log line, or null when nothing was done
 */
function zk_backfill_run_one(PDO $db) {
    static $staleChecked = 0;
    if (time() - $staleChecked >= 60) {
        $staleChecked = time();
        $db->exec("UPDATE zkill_backfill SET status = 'queued' WHERE status = 'running'
            AND attemptedAt < UTC_TIMESTAMP() - INTERVAL " . ZK_BACKFILL_STALE_RUNNING . ' SECOND');
    }
    if (!zk_http_ready('zkillboard.com')) return null;
    $job = $db->query("SELECT systemID, windowSeconds FROM zkill_backfill WHERE status = 'queued'
        ORDER BY priority DESC, requestedAt LIMIT 1")->fetch(PDO::FETCH_ASSOC);
    if (!$job) return null;
    $systemID = (int) $job['systemID'];
    $db->prepare("UPDATE zkill_backfill SET status = 'running', attemptedAt = UTC_TIMESTAMP(), attempts = attempts + 1 WHERE systemID = ?")
        ->execute([$systemID]);
    $window = min(max(3600, (int) $job['windowSeconds']), zk_retention_seconds());
    try {
        return zk_backfill_job($db, $systemID, $window);
    } catch (Throwable $error) {
        try {
            zk_backfill_finish($db, $systemID, 'failed', $window, null, null, 'error: ' . $error->getMessage());
        } catch (Throwable $ignored) {
            // the database is gone; the stale-running check re-queues the job later
        }
        if ($error instanceof PDOException) throw $error;
        return "back-fill $systemID failed: " . $error->getMessage();
    }
}

function zk_backfill_job(PDO $db, $systemID, $window) {
    $pastSeconds = min(604800, (int) ceil($window / 3600) * 3600);
    $started = time();
    [$status, $list] = zk_http_get_json(ZK_API_BASE . 'systemID/' . $systemID . '/pastSeconds/' . $pastSeconds . '/', false, ZK_BACKFILL_TIMEOUT);
    if (!is_array($list)) {
        $error = $status === -1 ? 'zKillboard: rate limited' : ($status === 200 ? 'zKillboard: not JSON' : "zKillboard: HTTP $status");
        zk_backfill_finish($db, $systemID, $status === -1 ? 'queued' : 'failed', $window, null, null, $status === -1 ? '' : $error);
        return "back-fill $systemID: $error";
    }

    $stored = 0;
    $entries = [];     // killID => kill time of a stored entry, null for one that was not stored
    $missing = [];     // ESI URL => [killID, zkb part] for entries without the killmail itself
    foreach ($list as $entry) {
        $killID = is_array($entry) && isset($entry['killmail_id']) && ctype_digit((string) $entry['killmail_id']) ? (int) $entry['killmail_id'] : null;
        if ($killID === null) continue;   // not a kill at all
        $row = zk_killmail_row($entry);
        if ($row !== null) {
            $entries[$killID] = zk_unix($row['killTime']);
            if (zk_store_killmail($db, $entry, 'backfill')) $stored++;
        } elseif (isset($entry['zkb']['hash']) && ctype_xdigit((string) $entry['zkb']['hash']) && count($missing) < ZK_BACKFILL_ESI_MAX) {
            $missing[ZK_ESI_BASE . 'killmails/' . $killID . '/' . $entry['zkb']['hash']] = [$killID, $entry['zkb']];
            $entries[$killID] = null;   // until ESI delivers it
        } else {
            $entries[$killID] = null;
        }
    }
    $failed = 0;
    if ($missing) {
        $results = zk_http_get_many(array_keys($missing), 5, ZK_BACKFILL_TIMEOUT, microtime(true) + ZK_BACKFILL_BUDGET);
        foreach ($results as $url => [$esiStatus, $esiBody]) {
            [$killID, $zkb] = $missing[$url];
            $killmail = $esiStatus === 200 ? json_decode($esiBody, true) : null;
            $row = is_array($killmail) ? zk_killmail_row($killmail + ['zkb' => $zkb]) : null;
            if ($row === null) {
                if ($esiStatus !== -1) $failed++;
                continue;
            }
            $entries[$killID] = zk_unix($row['killTime']);
            if (zk_store_killmail($db, $killmail + ['zkb' => $zkb], 'backfill')) $stored++;
        }
    }

    if ($failed) {
        zk_backfill_finish($db, $systemID, 'failed', $window, null, null, "ESI: $failed of " . count($missing) . ' killmails failed');
        return "back-fill $systemID: stored $stored, $failed killmails failed on ESI";
    }
    $coveredFrom = zk_backfill_covered_from($started, $pastSeconds, count($list), $entries);
    $partial = in_array(null, $entries, true);
    zk_backfill_finish($db, $systemID, 'done', $pastSeconds, gmdate('Y-m-d H:i:s', $started), gmdate('Y-m-d H:i:s', $coveredFrom), '');
    return "back-fill $systemID: " . count($list) . " kills in the last {$pastSeconds}s, $stored new"
        . ($partial ? ', partial (covered from ' . gmdate('Y-m-d H:i', $coveredFrom) . ')' : '');
}
