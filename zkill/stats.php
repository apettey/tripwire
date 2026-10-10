<?php
// Fork-owned: per-system statistics of the zKillboard integration (System Threat, see zkill/zkill.inc.php).
//
// The stream keeps kills for ZKILL_RETENTION_HOURS only, so longer history (kills in the last 7 days, monthly kill
// totals, the most active corporations / alliances of the week) comes from zKillboard's per-system stats endpoint
// https://zkillboard.com/api/stats/solarSystemID/<id>/kills/ (one request per system, a few KB after compaction).
// Like back-fills, it is never called from a web request: endpoints call zk_stats_request(), which reads the cache
// table zkill_system_stats and queues systems whose entry is missing or older than ZK_STATS_TTL (bounded: valid
// systems only, ZK_STATS_MAX_QUEUED overall, ZK_STATS_MAX_PER_USER per user). The worker drains the queue with
// zk_stats_run_one() at the lowest priority: only while the stream is caught up, only when no back-fill is queued,
// and through the same rate-limited client (ZKILL_API_INTERVAL between zKillboard API requests).

const ZK_STATS_TTL          = 43200;   // seconds a fetched entry stays fresh (zKillboard itself caches these for hours)
const ZK_STATS_RETRY        = 900;     // seconds before a failed fetch is queued again
const ZK_STATS_MAX_QUEUED   = 400;     // queued + running rows above which nothing new is queued
const ZK_STATS_MAX_PER_USER = 200;     // queued + running rows one user may have added
const ZK_STATS_PRIORITY     = ['chain' => 10, 'detail' => 20];   // request source => queue priority
const ZK_STATS_KEEP_DAYS    = 14;      // rows nobody asked for in this many days are pruned
const ZK_STATS_TIMEOUT      = 10;      // seconds per request
const ZK_STATS_TOP          = 10;      // entries kept per top list
const ZK_STATS_MONTHS       = 4;       // most recent months kept

/**
 * Compact cache entry from a zKillboard stats answer, or null when it isn't one (error object, junk).
 * kills7d / pilots7d / corporations7d / alliances7d: zKillboard's "active PvP" numbers of the last 7 days (no NPC
 * kills; zKillboard leaves a number out when it is 0 or 1); corporations / alliances: its 7-day top lists (kills as
 * attackers); months: the most recent monthly totals, newest first.
 */
function zk_stats_compact($data) {
    if (!is_array($data) || isset($data['error'])) return null;
    if (!isset($data['months']) && !isset($data['activepvp']) && !isset($data['topLists']) && !isset($data['shipsDestroyed'])) return null;
    $count = function ($key) use ($data) {
        $entry = $data['activepvp'][$key] ?? null;
        return is_array($entry) && is_numeric($entry['count'] ?? null) ? max(0, (int) $entry['count']) : 0;
    };
    $months = [];
    foreach ((is_array($data['months'] ?? null) ? $data['months'] : []) as $month) {
        if (!is_array($month) || !is_numeric($month['year'] ?? null) || !is_numeric($month['month'] ?? null)) continue;
        $months[] = [
            'year' => (int) $month['year'],
            'month' => (int) $month['month'],
            'kills' => is_numeric($month['shipsDestroyed'] ?? null) ? (int) $month['shipsDestroyed'] : 0,
            'isk' => is_numeric($month['iskDestroyed'] ?? null) ? (float) $month['iskDestroyed'] : 0.0,
        ];
    }
    usort($months, function ($a, $b) { return ($b['year'] * 100 + $b['month']) - ($a['year'] * 100 + $a['month']); });
    $top = ['corporation' => [], 'alliance' => []];
    foreach ((is_array($data['topLists'] ?? null) ? $data['topLists'] : []) as $list) {
        $type = is_array($list) ? ($list['type'] ?? '') : '';
        if (!isset($top[$type]) || !is_array($list['values'] ?? null)) continue;
        $ticker = $type === 'corporation' ? 'cticker' : 'aticker';
        foreach ($list['values'] as $value) {
            $id = is_array($value) && is_numeric($value[$type . 'ID'] ?? ($value['id'] ?? null)) ? (int) ($value[$type . 'ID'] ?? $value['id']) : 0;
            if ($id <= 0 || count($top[$type]) >= ZK_STATS_TOP) continue;
            $top[$type][] = [
                'id' => $id,
                'name' => mb_substr((string) ($value[$type . 'Name'] ?? ($value['name'] ?? '')), 0, 100),
                'ticker' => mb_substr((string) ($value[$ticker] ?? ''), 0, 10),
                'kills' => is_numeric($value['kills'] ?? null) ? (int) $value['kills'] : 0,
                'isk' => is_numeric($value['isk'] ?? null) ? (float) $value['isk'] : 0.0,
            ];
        }
    }
    return [
        'kills7d' => $count('kills'),
        'pilots7d' => $count('characters'),
        'corporations7d' => $count('corporations'),
        'alliances7d' => $count('alliances'),
        'months' => array_slice($months, 0, ZK_STATS_MONTHS),
        'gangRatio' => is_numeric($data['gangRatio'] ?? null) ? (int) $data['gangRatio'] : null,
        'avgGangSize' => is_numeric($data['avgGangSize'] ?? null) ? (float) $data['avgGangSize'] : null,
        'allTimeKills' => is_numeric($data['shipsDestroyed'] ?? null) ? (int) $data['shipsDestroyed'] : 0,
        'corporations' => $top['corporation'],
        'alliances' => $top['alliance'],
    ];
}

/**
 * Whether to (re)queue a system's stats.
 * @param array|null $row ['status', 'fetchedAt' => unix|null, 'attemptedAt' => unix|null, 'priority']
 * @return array ['queue' => queue / raise it now, 'pending' => a fetch is under way or about to be]
 */
function zk_stats_decision($row, $now, $priority = 10) {
    if (!$row) return ['queue' => true, 'pending' => true];
    $status = $row['status'];
    if ($status === 'queued' || $status === 'running') {
        return ['queue' => $status === 'queued' && ($row['priority'] ?? 0) < $priority, 'pending' => true];
    }
    $fresh = $row['fetchedAt'] !== null && $row['fetchedAt'] > $now - ZK_STATS_TTL;
    if ($status === 'done' && $fresh) return ['queue' => false, 'pending' => false];
    // Stale, or failed: wait out the retry period after the last attempt
    if ($row['attemptedAt'] !== null && $row['attemptedAt'] > $now - ZK_STATS_RETRY) return ['queue' => false, 'pending' => false];
    return ['queue' => true, 'pending' => true];
}

/** Whether a new queue entry may be added (overall and per-user caps) */
function zk_stats_admit($queued, $queuedByUser, $userID) {
    return $queued < ZK_STATS_MAX_QUEUED && ($userID <= 0 || $queuedByUser < ZK_STATS_MAX_PER_USER);
}

/**
 * Cached stats of the systems, queueing missing / stale ones for the worker unless $options['queue'] is false.
 * @param array $options queue (bool), source ('chain'|'detail'), userID (int)
 * @return array systemID => ['stats' => compact entry|null, 'fetchedAt' => unix|null, 'status' => string|null,
 *                            'pending' => bool, 'queueFull' => bool]
 */
function zk_stats_request(PDO $db, array $systemIDs, array $options = []) {
    $queue = $options['queue'] ?? true;
    $source = isset(ZK_STATS_PRIORITY[$options['source'] ?? '']) ? $options['source'] : 'chain';
    $priority = ZK_STATS_PRIORITY[$source];
    $userID = (int) ($options['userID'] ?? 0);
    $now = time();
    $rows = [];
    if ($systemIDs) {
        $in = implode(',', array_fill(0, count($systemIDs), '?'));
        $stmt = $db->prepare("SELECT systemID, status, priority, fetchedAt, attemptedAt, data FROM zkill_system_stats WHERE systemID IN ($in)");
        $stmt->execute(array_values($systemIDs));
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $rows[(int) $row['systemID']] = $row;
        // Remember that someone still wants these (pruning keeps rows asked for in the last ZK_STATS_KEEP_DAYS)
        if ($queue && $rows) {
            $known = array_keys($rows);
            $db->prepare('UPDATE zkill_system_stats SET wantedAt = UTC_TIMESTAMP() WHERE systemID IN ('
                . implode(',', array_fill(0, count($known), '?')) . ') AND wantedAt < UTC_TIMESTAMP() - INTERVAL 1 HOUR')->execute($known);
        }
    }
    $queued = null;
    $queuedByUser = null;
    $enqueue = $db->prepare("INSERT INTO zkill_system_stats (systemID, status, priority, requestedBy, requestedAt, wantedAt)
        VALUES (?, 'queued', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
            requestedAt = IF(status = 'queued', requestedAt, VALUES(requestedAt)),
            requestedBy = IF(status = 'queued', requestedBy, VALUES(requestedBy)),
            priority = IF(status = 'queued', GREATEST(priority, VALUES(priority)), VALUES(priority)),
            status = IF(status = 'running', status, 'queued')");

    $result = [];
    foreach ($systemIDs as $systemID) {
        $row = $rows[$systemID] ?? null;
        $state = $row ? [
            'status' => $row['status'],
            'priority' => (int) $row['priority'],
            'fetchedAt' => zk_unix($row['fetchedAt']),
            'attemptedAt' => zk_unix($row['attemptedAt']),
        ] : null;
        $decision = zk_stats_decision($state, $now, $priority);
        $status = $row ? $row['status'] : null;
        $queueFull = false;
        if (!$queue) {
            $decision = ['queue' => false, 'pending' => $status === 'queued' || $status === 'running'];
        } elseif ($decision['queue'] && !($status === 'queued' || $status === 'running')) {
            if ($queued === null) {
                $queued = (int) $db->query("SELECT COUNT(*) FROM zkill_system_stats WHERE status IN ('queued', 'running')")->fetchColumn();
                $byUser = $db->prepare("SELECT COUNT(*) FROM zkill_system_stats WHERE requestedBy = ? AND status IN ('queued', 'running')");
                $byUser->execute([$userID]);
                $queuedByUser = (int) $byUser->fetchColumn();
            }
            if (zk_stats_admit($queued, $queuedByUser, $userID)) {
                $queued++;
                $queuedByUser++;
            } else {
                $queueFull = true;
                $decision = ['queue' => false, 'pending' => false];
            }
        }
        if ($decision['queue']) {
            $enqueue->execute([$systemID, $priority, $userID]);
            if ($status !== 'running') $status = 'queued';
        }
        $data = $row && $row['data'] !== null && $row['data'] !== '' ? json_decode($row['data'], true) : null;
        $result[$systemID] = [
            'stats' => is_array($data) ? $data : null,
            'fetchedAt' => $state ? $state['fetchedAt'] : null,
            'status' => $status,
            'pending' => $decision['pending'],
            'queueFull' => $queueFull,
        ];
    }
    return $result;
}

/**
 * Worker: put 'running' rows older than 5 minutes (a crashed or restarted worker) back in the queue and, with $prune,
 * delete rows nobody asked for in ZK_STATS_KEEP_DAYS days.
 */
function zk_stats_housekeeping(PDO $db, $now, $prune = true) {
    $db->prepare("UPDATE zkill_system_stats SET status = 'queued' WHERE status = 'running' AND attemptedAt < ?")
        ->execute([gmdate('Y-m-d H:i:s', $now - 300)]);
    if ($prune) {
        $db->prepare("DELETE FROM zkill_system_stats WHERE wantedAt < ? AND status <> 'running'")
            ->execute([gmdate('Y-m-d H:i:s', $now - ZK_STATS_KEEP_DAYS * 86400)]);
    }
}

/**
 * Worker: fetch the most important queued system's stats, but only when the zKillboard API may be called now and
 * no back-fill is waiting (back-fills serve open panels; stats are background data). Prunes old rows hourly.
 * @return string|null log line, or null when nothing was done
 */
function zk_stats_run_one(PDO $db) {
    static $staleChecked = 0, $pruned = 0;
    $now = time();
    $stale = $now - $staleChecked >= 60;
    $prune = $now - $pruned >= 3600;
    if ($stale) $staleChecked = $now;
    if ($prune) $pruned = $now;
    if ($stale || $prune) zk_stats_housekeeping($db, $now, $prune);
    if (!zk_http_ready('zkillboard.com')) return null;
    if ($db->query("SELECT 1 FROM zkill_backfill WHERE status = 'queued' LIMIT 1")->fetchColumn()) return null;
    $job = $db->query("SELECT systemID FROM zkill_system_stats WHERE status = 'queued' ORDER BY priority DESC, requestedAt LIMIT 1")->fetchColumn();
    if ($job === false) return null;
    $systemID = (int) $job;
    $db->prepare("UPDATE zkill_system_stats SET status = 'running', attemptedAt = UTC_TIMESTAMP(), attempts = attempts + 1 WHERE systemID = ?")
        ->execute([$systemID]);
    // Plain SQL (no MySQL-only syntax) so zkill/tests/stats_test.php can run the worker path on SQLite
    $finish = $db->prepare('UPDATE zkill_system_stats SET status = ?, error = ?,
        data = COALESCE(?, data), fetchedAt = CASE WHEN ? IS NULL THEN fetchedAt ELSE UTC_TIMESTAMP() END WHERE systemID = ?');
    try {
        [$status, $data] = zk_http_get_json(ZK_API_BASE . 'stats/solarSystemID/' . $systemID . '/kills/', false, ZK_STATS_TIMEOUT);
        if ($status === -1) {
            $finish->execute(['queued', '', null, null, $systemID]);   // the limiter said no after all: try again later
            return null;
        }
        $stats = $status === 200 ? zk_stats_compact($data) : null;
        if ($stats === null) {
            $error = $status === 200 ? (is_array($data) && isset($data['error']) ? 'zKillboard: ' . (string) $data['error'] : 'zKillboard: unexpected answer') : "zKillboard: HTTP $status";
            $finish->execute(['failed', substr($error, 0, 255), null, null, $systemID]);
            return "stats $systemID: $error";
        }
        $json = json_encode($stats);
        $finish->execute(['done', '', $json, $json, $systemID]);
        return "stats $systemID: {$stats['kills7d']} kills in 7 days, " . count($stats['corporations']) . ' top corporations';
    } catch (Throwable $error) {
        try {
            $finish->execute(['failed', substr('error: ' . $error->getMessage(), 0, 255), null, null, $systemID]);
        } catch (Throwable $ignored) {
            // the database is gone; the stale-running check re-queues the job later
        }
        if ($error instanceof PDOException) throw $error;
        return "stats $systemID failed: " . $error->getMessage();
    }
}
