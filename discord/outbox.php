<?php
// Fork-owned: outbox and dedupe of the Discord notifications (see discord/discord.inc.php).

const DISCORD_OUTBOX_MASK_CAP   = 500;     // queued messages per mask; above it new notifications are dropped (logged)
const DISCORD_OUTBOX_EXPIRE     = 21600;   // seconds a message may wait (6 h); older queued ones are given up
const DISCORD_OUTBOX_KEEP_SENT  = 7;       // days
const DISCORD_OUTBOX_KEEP_FAILED = 14;     // days
const DISCORD_DEDUPE_KEEP       = 7;       // days
const DISCORD_PRIORITY_TEST     = 30;
const DISCORD_PRIORITY_DEFAULT  = 10;

/** Remember a notification (mask, kind, ref) once. Returns true the first time, false if it was already there. */
function discord_dedupe_once(PDO $db, $maskID, $kind, $ref) {
    $stmt = $db->prepare('INSERT IGNORE INTO discord_sent (maskID, kind, ref, createdAt) VALUES (?, ?, ?, UTC_TIMESTAMP())');
    $stmt->execute([$maskID, $kind, substr((string) $ref, 0, 64)]);
    return $stmt->rowCount() > 0;
}

/**
 * Cooldown dedupe: true (and the time is recorded) when (mask, kind, ref) was not recorded in the last $seconds.
 * Atomic: insert, or move an expired record to now (MySQL reports 1 = inserted, 2 = updated, 0 = still cooling down).
 */
function discord_dedupe_cooldown(PDO $db, $maskID, $kind, $ref, $seconds) {
    $stmt = $db->prepare('INSERT INTO discord_sent (maskID, kind, ref, createdAt) VALUES (?, ?, ?, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE createdAt = IF(createdAt < UTC_TIMESTAMP() - INTERVAL ' . (int) $seconds . ' SECOND, VALUES(createdAt), createdAt)');
    $stmt->execute([$maskID, $kind, substr((string) $ref, 0, 64)]);
    return $stmt->rowCount() > 0;
}

/** Queue a message. Returns the outbox id, or null when the mask's queue is full. */
function discord_enqueue(PDO $db, $maskID, $webhookID, $kind, array $data, $priority = DISCORD_PRIORITY_DEFAULT) {
    $stmt = $db->prepare("SELECT COUNT(*) FROM discord_outbox WHERE maskID = ? AND status = 'queued'");
    $stmt->execute([$maskID]);
    if ((int) $stmt->fetchColumn() >= DISCORD_OUTBOX_MASK_CAP) {
        discord_log("outbox full for mask $maskID, dropped a $kind notification");
        return null;
    }
    $stmt = $db->prepare("INSERT INTO discord_outbox (maskID, webhookID, kind, priority, data, status, nextAttemptAt, createdAt)
        VALUES (?, ?, ?, ?, ?, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())");
    $stmt->execute([$maskID, (int) $webhookID, $kind, (int) $priority, json_encode($data)]);
    return (int) $db->lastInsertId();
}

/**
 * Per-mask rate limit (test messages, webhook URL changes), race-free: record the action first, then count the
 * records in the window including it; over $max, take the record back and refuse. Two concurrent requests can both
 * be refused at the edge, never both let through.
 */
function discord_rate_take(PDO $db, $maskID, $kind, $max, $seconds) {
    $ref = bin2hex(random_bytes(8));
    $db->prepare('INSERT INTO discord_sent (maskID, kind, ref, createdAt) VALUES (?, ?, ?, UTC_TIMESTAMP())')->execute([$maskID, $kind, $ref]);
    $stmt = $db->prepare('SELECT COUNT(*) FROM discord_sent WHERE maskID = ? AND kind = ? AND createdAt >= ?');
    $stmt->execute([$maskID, $kind, gmdate('Y-m-d H:i:s', time() - (int) $seconds)]);
    if ((int) $stmt->fetchColumn() <= $max) return true;
    $db->prepare('DELETE FROM discord_sent WHERE maskID = ? AND kind = ? AND ref = ?')->execute([$maskID, $kind, $ref]);
    return false;
}

/**
 * Queue a message only if $claim() records its dedupe row (returns true), in one transaction: the dedupe row exists
 * exactly when the message was queued (a full queue rolls both back), and two processes can't both queue it (the
 * dedupe row's primary key decides). Returns the outbox id or null.
 */
function discord_enqueue_once(PDO $db, $maskID, $webhookID, $kind, array $data, callable $claim, $priority = DISCORD_PRIORITY_DEFAULT) {
    $db->beginTransaction();
    try {
        $id = $claim() ? discord_enqueue($db, $maskID, $webhookID, $kind, $data, $priority) : null;
        if ($id === null) { $db->rollBack(); return null; }
        $db->commit();
        return $id;
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        throw $error;
    }
}

/**
 * Delivery status of a mask for its settings page: queued now, sent / failed in the last 24 h, the last 5 failures
 * and the circuit breakers open now (discord_breaker_note). Each query has its own statement. Times are passed in
 * (UTC) so the SQL stays portable (tested on SQLite).
 */
function discord_outbox_status(PDO $db, $maskID, $now = null) {
    $now = $now ?? time();
    $nowText = gmdate('Y-m-d H:i:s', $now);
    $dayAgo = gmdate('Y-m-d H:i:s', $now - 86400);
    $countStmt = $db->prepare("SELECT
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN status = 'sent' AND sentAt >= ? THEN 1 ELSE 0 END) AS sent24h,
            SUM(CASE WHEN status = 'failed' AND createdAt >= ? THEN 1 ELSE 0 END) AS failed24h
        FROM discord_outbox WHERE maskID = ?");
    $countStmt->execute([$dayAgo, $dayAgo, $maskID]);
    $counts = $countStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    $failureStmt = $db->prepare("SELECT o.id, o.kind, o.lastError, o.createdAt, w.name AS webhook FROM discord_outbox o
        LEFT JOIN discord_webhooks w ON w.id = o.webhookID
        WHERE o.maskID = ? AND o.status = 'failed' ORDER BY o.id DESC LIMIT 5");
    $failureStmt->execute([$maskID]);
    $failures = array_map(function ($r) {
        return ['id' => (int) $r['id'], 'kind' => $r['kind'], 'error' => $r['lastError'], 'createdAt' => discord_iso($r['createdAt']), 'webhook' => $r['webhook']];
    }, $failureStmt->fetchAll(PDO::FETCH_ASSOC));
    $pausedStmt = $db->prepare("SELECT ref, createdAt FROM discord_sent WHERE maskID = ? AND kind = 'breaker' AND createdAt > ?");
    $pausedStmt->execute([$maskID, $nowText]);
    $paused = array_map(function ($r) {
        $scope = explode(':', $r['ref'], 2);
        return ['scope' => $scope[0], 'webhookID' => $scope[0] === 'webhook' ? (int) $scope[1] : null, 'until' => discord_iso($r['createdAt'])];
    }, $pausedStmt->fetchAll(PDO::FETCH_ASSOC));
    return ['queued' => (int) ($counts['queued'] ?? 0), 'sent24h' => (int) ($counts['sent24h'] ?? 0),
        'failed24h' => (int) ($counts['failed24h'] ?? 0), 'failures' => $failures, 'paused' => $paused];
}

/** Due messages, highest priority first, at most $limit */
function discord_outbox_due(PDO $db, $limit) {
    $stmt = $db->query("SELECT o.id, o.maskID, o.webhookID, o.kind, o.data, o.attempts,
            TIMESTAMPDIFF(SECOND, o.createdAt, UTC_TIMESTAMP()) AS age
        FROM discord_outbox o
        WHERE o.status = 'queued' AND o.nextAttemptAt <= UTC_TIMESTAMP()
        ORDER BY o.priority DESC, o.id ASC
        LIMIT " . (int) $limit);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function discord_outbox_mark(PDO $db, $id, $status, $error = '', $retryInSeconds = 0, $countAttempt = true) {
    if ($status === 'queued') {
        $stmt = $db->prepare('UPDATE discord_outbox SET attempts = attempts + ?, lastError = ?,
            nextAttemptAt = UTC_TIMESTAMP() + INTERVAL ? SECOND WHERE id = ?');
        $stmt->execute([$countAttempt ? 1 : 0, substr((string) $error, 0, 255), max(0, (int) ceil($retryInSeconds)), $id]);
    } else {
        $stmt = $db->prepare("UPDATE discord_outbox SET status = ?, attempts = attempts + 1, lastError = ?,
            sentAt = IF(? = 'sent', UTC_TIMESTAMP(), sentAt) WHERE id = ?");
        $stmt->execute([$status, substr((string) $error, 0, 255), $status, $id]);
    }
}

/** Give up every queued message of a webhook (it is broken or was deleted) */
function discord_outbox_fail_webhook(PDO $db, $webhookID, $reason) {
    $stmt = $db->prepare("UPDATE discord_outbox SET status = 'failed', lastError = ? WHERE webhookID = ? AND status = 'queued'");
    $stmt->execute([substr((string) $reason, 0, 255), (int) $webhookID]);
    return $stmt->rowCount();
}

/** Expire stale queued messages, delete old sent/failed rows and old dedupe records. Returns [expired, deleted]. */
function discord_outbox_prune(PDO $db) {
    $expired = $db->exec("UPDATE discord_outbox SET status = 'failed', lastError = 'expired: not sent within "
        . (DISCORD_OUTBOX_EXPIRE / 3600) . " h' WHERE status = 'queued' AND createdAt < UTC_TIMESTAMP() - INTERVAL " . DISCORD_OUTBOX_EXPIRE . ' SECOND');
    $deleted = $db->exec("DELETE FROM discord_outbox WHERE (status = 'sent' AND createdAt < UTC_TIMESTAMP() - INTERVAL " . DISCORD_OUTBOX_KEEP_SENT . " DAY)
        OR (status = 'failed' AND createdAt < UTC_TIMESTAMP() - INTERVAL " . DISCORD_OUTBOX_KEEP_FAILED . ' DAY)');
    $db->exec('DELETE FROM discord_sent WHERE createdAt < UTC_TIMESTAMP() - INTERVAL ' . DISCORD_DEDUPE_KEEP . ' DAY');
    return [(int) $expired, (int) $deleted];
}

/** Retry delay after a temporary failure (5xx, network): 5 s, 10 s, 20 s ... capped at 15 minutes */
function discord_retry_delay($attempts) {
    return min(900, 5 * (2 ** min(10, max(0, (int) $attempts))));
}

const DISCORD_MAX_ATTEMPTS = 10;   // temporary failures before a message is given up (~1 h of retries)
