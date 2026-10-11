<?php
// Fork-owned: single-kill lookups of the zKillboard integration (Smart notes kill cards, see zkill/zkill.inc.php).
//
// A note can link any kill, also one the stream never saw or that was pruned. Endpoints (public/zkill_kill.php) call
// zk_lookup_request(): kills already in zkill_killmails are answered from there, the rest are queued in
// zkill_kill_lookup (bounded: ZK_LOOKUP_MAX_PER_USER per user, ZK_LOOKUP_MAX_QUEUED overall). The worker drains the
// queue with zk_lookup_run_one() after the stream, interleaved with back-fills and stats (zk_queues_run_one(): at
// most every other API slot while they have work), only while both zKillboard and ESI may be called, within the same budget
// (ZKILL_API_INTERVAL): zKillboard /api/killID/<id>/ for the hash, ESI /killmails/<id>/<hash>/ for the killmail,
// stored with source 'lookup'. A failed lookup is retried after ZK_LOOKUP_RETRY seconds, at most ZK_LOOKUP_MAX_ATTEMPTS
// times. Looked-up kills are kept ZK_LOOKUP_KEEP_DAYS days after they were fetched (zk_prune()), then fetched again
// on demand. SQL in the worker path is plain (no MySQL-only syntax) so zkill/tests/lookup_test.php runs it on SQLite.

const ZK_LOOKUP_MAX_IDS       = 20;     // kill IDs per endpoint request
const ZK_LOOKUP_MAX_PER_USER  = 200;    // queued + running rows one user may have added
const ZK_LOOKUP_MAX_QUEUED    = 2000;   // queued + running rows overall
const ZK_LOOKUP_RETRY         = 600;    // seconds before a failed lookup is queued again
const ZK_LOOKUP_MAX_ATTEMPTS  = 3;
const ZK_LOOKUP_STALE_RUNNING = 300;    // seconds after which a 'running' lookup counts as abandoned
const ZK_LOOKUP_TIMEOUT       = 10;     // seconds per HTTP request
const ZK_LOOKUP_KEEP_DAYS     = 7;      // looked-up kills and finished queue rows are kept this long

/** A plausible killmail ID: a positive integer of at most 12 digits (given as int or digit string) */
function zk_lookup_valid_id($id) {
    if (is_int($id)) return $id > 0 && $id < 1000000000000;
    return is_string($id) && $id !== '' && strlen($id) <= 12 && ctype_digit($id) && (int) $id > 0;
}

/**
 * What to do for a kill that is not in zkill_killmails.
 * @param array|null $row its queue row: ['status', 'attempts', 'attemptedAt' => unix|null]
 * @return array ['action' => 'insert'|'requeue'|'none', 'status' => what the browser is told:
 *               'queued' (ask again soon), 'failed' (show the plain link), 'unavailable' (the feed is off)]
 */
function zk_lookup_decision($row, $now, $feedEnabled = true) {
    if (!$feedEnabled) return ['action' => 'none', 'status' => 'unavailable'];   // nobody drains the queue
    if (!$row) return ['action' => 'insert', 'status' => 'queued'];
    $status = $row['status'];
    if ($status === 'queued' || $status === 'running') return ['action' => 'none', 'status' => 'queued'];
    // Done but not stored any more (pruned): fetch it again
    if ($status === 'done') return ['action' => 'requeue', 'status' => 'queued'];
    if ((int) $row['attempts'] < ZK_LOOKUP_MAX_ATTEMPTS && ($row['attemptedAt'] === null || $row['attemptedAt'] <= $now - ZK_LOOKUP_RETRY)) {
        return ['action' => 'requeue', 'status' => 'queued'];
    }
    return ['action' => 'none', 'status' => 'failed'];
}

/** Whether a new queue entry may be added (overall and per-user caps) */
function zk_lookup_admit($queued, $queuedByUser, $userID) {
    return $queued < ZK_LOOKUP_MAX_QUEUED && ($userID <= 0 || $queuedByUser < ZK_LOOKUP_MAX_PER_USER);
}

/**
 * Stored kills and queue state for the given kill IDs; kills that are not stored are queued for the worker (unless
 * the feed is off or a cap is reached).
 * @return array killID => ['status' => 'ok', 'row' => zkill_killmails row] or ['status' => 'queued'|'failed'|'full'|'unavailable']
 */
function zk_lookup_request(PDO $db, array $killIDs, $userID, $feedEnabled = null) {
    $feedEnabled = $feedEnabled === null ? zk_feed_enabled() : (bool) $feedEnabled;
    $userID = (int) $userID;
    $ids = array_values(array_unique(array_map('intval', array_filter($killIDs, 'zk_lookup_valid_id'))));
    $result = [];
    if (!$ids) return $result;
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT killID, systemID, killTime, victimCharacterID, victimCorporationID, victimAllianceID, victimShipTypeID,
            finalBlowCharacterID, finalBlowCorporationID, finalBlowAllianceID, finalBlowShipTypeID, attackerCount, attackerTotal,
            totalValue, npc, solo, awox FROM zkill_killmails WHERE killID IN ($in)");
    $stmt->execute($ids);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $result[(int) $row['killID']] = ['status' => 'ok', 'row' => $row];

    $missing = array_values(array_filter($ids, function ($id) use ($result) { return !isset($result[$id]); }));
    if (!$missing) return $result;
    $rows = [];
    $in = implode(',', array_fill(0, count($missing), '?'));
    $stmt = $db->prepare("SELECT killID, status, attempts, attemptedAt FROM zkill_kill_lookup WHERE killID IN ($in)");
    $stmt->execute($missing);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $rows[(int) $row['killID']] = $row;

    $now = time();
    $nowSql = gmdate('Y-m-d H:i:s', $now);
    $queued = null;
    $queuedByUser = null;
    foreach ($missing as $killID) {
        $row = $rows[$killID] ?? null;
        $decision = zk_lookup_decision($row ? [
            'status' => $row['status'],
            'attempts' => (int) $row['attempts'],
            'attemptedAt' => zk_unix($row['attemptedAt']),
        ] : null, $now, $feedEnabled);
        if ($decision['action'] !== 'none') {
            if ($queued === null) {
                $queued = (int) $db->query("SELECT COUNT(*) FROM zkill_kill_lookup WHERE status IN ('queued', 'running')")->fetchColumn();
                $byUser = $db->prepare("SELECT COUNT(*) FROM zkill_kill_lookup WHERE requestedBy = ? AND status IN ('queued', 'running')");
                $byUser->execute([$userID]);
                $queuedByUser = (int) $byUser->fetchColumn();
            }
            if (!zk_lookup_admit($queued, $queuedByUser, $userID)) {
                $result[$killID] = ['status' => 'full'];
                continue;
            }
            $queued++;
            $queuedByUser++;
            if ($decision['action'] === 'insert') {
                try {
                    $db->prepare("INSERT INTO zkill_kill_lookup (killID, status, attempts, requestedBy, requestedAt) VALUES (?, 'queued', 0, ?, ?)")
                        ->execute([$killID, $userID, $nowSql]);
                } catch (PDOException $error) {
                    // Another request queued it a moment ago (portable instead of INSERT IGNORE, for the SQLite tests)
                    if ($error->getCode() !== '23000') throw $error;
                }
            } else {
                // attempts first: MySQL evaluates SET left to right (a done row starts over, a failed one keeps counting)
                $db->prepare("UPDATE zkill_kill_lookup SET attempts = CASE WHEN status = 'done' THEN 0 ELSE attempts END,
                    status = 'queued', requestedBy = ?, requestedAt = ?, error = '' WHERE killID = ?")
                    ->execute([$userID, $nowSql, $killID]);
            }
        }
        $result[$killID] = ['status' => $decision['status']];
    }
    return $result;
}

/** Store a looked-up killmail row regardless of the retention window (zk_prune() keeps 'lookup' rows by receivedAt) */
function zk_lookup_store(PDO $db, array $row) {
    $exists = $db->prepare('SELECT 1 FROM zkill_killmails WHERE killID = ?');
    $exists->execute([$row['killID']]);
    if ($exists->fetchColumn()) return false;
    $columns = array_keys($row);
    $params = [];
    foreach ($row as $column => $value) $params[':' . $column] = $value;
    $params[':source'] = 'lookup';
    try {
        $db->prepare('INSERT INTO zkill_killmails (' . implode(', ', $columns) . ', source, receivedAt)
            VALUES (' . implode(', ', array_keys(array_diff_key($params, [':source' => 1]))) . ', :source, UTC_TIMESTAMP())')->execute($params);
    } catch (PDOException $error) {
        if ($error->getCode() === '23000') return false;   // the stream stored it in the meantime
        throw $error;
    }
    return true;
}

/** Worker: put 'running' lookups older than ZK_LOOKUP_STALE_RUNNING seconds (crashed / restarted worker) back in the queue */
function zk_lookup_housekeeping(PDO $db, $now) {
    $db->prepare("UPDATE zkill_kill_lookup SET status = 'queued' WHERE status = 'running' AND attemptedAt < ?")
        ->execute([gmdate('Y-m-d H:i:s', $now - ZK_LOOKUP_STALE_RUNNING)]);
}

/**
 * Worker: look up the oldest queued kill if the zKillboard API may be called now. Runs before back-fills (a note is
 * open and waiting for it). Any error marks the lookup failed (database errors are re-thrown after that).
 * @return string|null log line, or null when nothing was done
 */
function zk_lookup_run_one(PDO $db) {
    static $staleChecked = 0;
    $now = time();
    if ($now - $staleChecked >= 60) {
        $staleChecked = $now;
        zk_lookup_housekeeping($db, $now);
    }
    // Both hosts must be free: with ESI paused, asking zKillboard for the hash would only be wasted and repeated
    if (!zk_http_ready('zkillboard.com') || !zk_http_ready('esi.evetech.net')) return null;
    $killID = $db->query("SELECT killID FROM zkill_kill_lookup WHERE status = 'queued' ORDER BY requestedAt, killID LIMIT 1")->fetchColumn();
    if ($killID === false) return null;
    $killID = (int) $killID;
    $db->prepare("UPDATE zkill_kill_lookup SET status = 'running', attemptedAt = ?, attempts = attempts + 1 WHERE killID = ?")
        ->execute([gmdate('Y-m-d H:i:s', $now), $killID]);
    $finish = $db->prepare('UPDATE zkill_kill_lookup SET status = ?, error = ? WHERE killID = ?');
    $notSent = $db->prepare("UPDATE zkill_kill_lookup SET status = 'queued', attempts = attempts - 1 WHERE killID = ?");
    try {
        [$status, $list] = zk_http_get_json(ZK_API_BASE . 'killID/' . $killID . '/', false, ZK_LOOKUP_TIMEOUT);
        if ($status === -1) {
            $notSent->execute([$killID]);   // the limiter said no after all: try again later, it doesn't count
            return null;
        }
        $entry = null;
        foreach (is_array($list) ? $list : [] as $candidate) {
            if (is_array($candidate) && isset($candidate['killmail_id']) && (string) $candidate['killmail_id'] === (string) $killID) $entry = $candidate;
        }
        if ($entry === null) {
            $error = $status !== 200 ? "zKillboard: HTTP $status" : (is_array($list) ? 'zKillboard: unknown kill' : 'zKillboard: unexpected answer');
            $finish->execute(['failed', $error, $killID]);
            return "kill lookup $killID: $error";
        }
        $zkb = is_array($entry['zkb'] ?? null) ? $entry['zkb'] : [];
        $row = zk_killmail_row($entry);   // zKillboard may send the killmail itself
        if ($row === null) {
            $hash = (string) ($zkb['hash'] ?? '');
            if ($hash === '' || strlen($hash) > 64 || !ctype_xdigit($hash)) {
                $finish->execute(['failed', 'zKillboard: no hash', $killID]);
                return "kill lookup $killID: zKillboard: no hash";
            }
            [$esiStatus, $killmail] = zk_http_get_json(ZK_ESI_BASE . 'killmails/' . $killID . '/' . $hash . '/', false, ZK_LOOKUP_TIMEOUT);
            if ($esiStatus === -1) {
                $notSent->execute([$killID]);
                return null;
            }
            $row = is_array($killmail) ? zk_killmail_row($killmail + ['zkb' => $zkb]) : null;
            if ($row === null || $row['killID'] !== $killID) {
                $error = $esiStatus === 200 ? 'ESI: unexpected answer' : "ESI: HTTP $esiStatus";
                $finish->execute(['failed', $error, $killID]);
                return "kill lookup $killID: $error";
            }
        }
        $stored = zk_lookup_store($db, $row);
        $finish->execute(['done', '', $killID]);
        return "kill lookup $killID: " . ($stored ? 'stored' : 'already stored') . " (system {$row['systemID']}, {$row['killTime']})";
    } catch (Throwable $error) {
        try {
            $finish->execute(['failed', substr('error: ' . $error->getMessage(), 0, 255), $killID]);
        } catch (Throwable $ignored) {
            // the database is gone; the stale-running check re-queues the lookup later
        }
        if ($error instanceof PDOException) throw $error;
        return "kill lookup $killID failed: " . $error->getMessage();
    }
}

/**
 * Worker: one step of the zKillboard API queues. Lookups (a note is open and waiting) go first, but after a lookup
 * the next step lets back-fills and stats go first, so a stream of lookups can at most take every other API slot
 * from the System Kill Feed and System Threat. With nothing else waiting, lookups run back to back. A pass in which no
 * step ran (the zKillboard API isn't free yet, which is most ticks: the worker ticks every 0.5 s, the API allows one
 * request per ZKILL_API_INTERVAL; or every queue is empty) keeps the turn, so back-fills and stats get the next free slot.
 * @param array|null $steps test hook: ['lookup' => callable, 'backfill' => callable, 'stats' => callable], each
 *                          callable($db) returning a log line or null (nothing done)
 * @return string|null log line of the step that ran
 */
function zk_queues_run_one(PDO $db, ?array $steps = null) {
    static $lookupNext = true;
    $steps = $steps ?? ['lookup' => 'zk_lookup_run_one', 'backfill' => 'zk_backfill_run_one', 'stats' => 'zk_stats_run_one'];
    $order = $lookupNext ? ['lookup', 'backfill', 'stats'] : ['backfill', 'stats', 'lookup'];
    foreach ($order as $name) {
        $line = $steps[$name]($db);
        if ($line !== null) {
            $lookupNext = $name !== 'lookup';
            return $line;
        }
    }
    return null;   // not ready or nothing to do: the turn stays as it is
}
