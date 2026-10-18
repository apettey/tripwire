<?php
// Fork-owned: first-party product analytics (see docker/README.md#product-analytics). Which fork features are used, by how
// many people, how often, and how often they are switched off. Written by public/fork_events.php from the counters
// app/js/fork/feature-usage.js sends; pruned by analytics_prune.cron.php.
//
// What is stored: per UTC day, an 8-byte pseudonymous user id, a feature id from public/fork/feature-catalog.json, an action
// (a short word such as "opened") and a count; first/last time per user and feature; and an 8-byte mask hash per day and
// feature, only to count "masks using" a feature. Never stored: account, character, corporation or mask ids/names, systems,
// signatures, IP addresses, user agents or any free text. Nothing leaves this server.
//
// The user id is HMAC-SHA256(salt, account id) cut to 8 bytes. A plain hash would be reversible (EVE ids are public); the
// salt is random, lives only in fork_analytics_meta and is replaced every ANALYTICS_DAYS days, the old one deleted, so rows
// from before cannot be tied to anyone, not even with database access.
//
// Nothing here throws to the caller: errors go to the PHP error log (like audit_record).

const ANALYTICS_CATALOG = __DIR__ . '/../public/fork/feature-catalog.json';   // public/fork/feature-catalog.json
const ANALYTICS_DEFAULT_DAYS = 90;
const ANALYTICS_MAX_DAYS = 3650;
const ANALYTICS_MAX_RAW_DAYS = 90;
const ANALYTICS_MAX_BODY = 8192;        // bytes of one request
const ANALYTICS_MAX_ENTRIES = 50;       // counters in one request
const ANALYTICS_MAX_COUNT = 1000;       // one counter in one request
const ANALYTICS_ACTION_RE = '/^[a-z_]{1,24}$/';
const ANALYTICS_FEATURE_RE = '/^[a-z][A-Za-z0-9]{1,39}$/';
// Actions every feature may report; the rest come from the feature's `use` list in the catalog
const ANALYTICS_GENERIC_ACTIONS = ['command', 'opened', 'shown', 'disabled', 'setting_on', 'setting_off', 'setting_changed'];
const ANALYTICS_INTERNAL_ACTIONS = ['app' => ['active']];
const ANALYTICS_USE_ACTIONS = ['command', 'opened'];   // count as use for every feature (plus its `use` list)
const ANALYTICS_MAX_DAILY = 10000;     // one counter (day, user, feature, action) in a day: no inflating it past this
// Requests per user and window: 1 a minute normally, plus one each time the tab is hidden and short bursts in
// forkUsage.debug (a send every 2.5 s at most). Over the limit a request is dropped; it still gets 204.
const ANALYTICS_RATE_WINDOW = 60;       // seconds
const ANALYTICS_RATE_MAX = 30;          // requests per window
const ANALYTICS_PRUNE_BATCH = 5000;
const ANALYTICS_PRUNE_ROUNDS = 20;

const ANALYTICS_DDL = [
    "CREATE TABLE IF NOT EXISTS `fork_analytics_daily` (
      `day` date NOT NULL,
      `feature` varchar(40) CHARACTER SET ascii NOT NULL,
      `action` varchar(24) CHARACTER SET ascii NOT NULL,
      `uid` char(16) CHARACTER SET ascii NOT NULL,
      `n` int unsigned NOT NULL DEFAULT 0,
      `firstMinute` smallint unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`day`, `feature`, `action`, `uid`),
      KEY `uid` (`uid`, `day`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_analytics_user` (
      `uid` char(16) CHARACTER SET ascii NOT NULL,
      `feature` varchar(40) CHARACTER SET ascii NOT NULL,
      `action` varchar(24) CHARACTER SET ascii NOT NULL,
      `firstAt` datetime NOT NULL,
      `lastAt` datetime NOT NULL,
      `n` int unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`uid`, `feature`, `action`),
      KEY `lastAt` (`lastAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_analytics_mask` (
      `day` date NOT NULL,
      `maskHash` char(16) CHARACTER SET ascii NOT NULL,
      `feature` varchar(40) CHARACTER SET ascii NOT NULL,
      PRIMARY KEY (`day`, `feature`, `maskHash`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_analytics_rate` (
      `uid` char(16) CHARACTER SET ascii NOT NULL,
      `windowStart` datetime NOT NULL,
      `n` int unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`uid`),
      KEY `windowStart` (`windowStart`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_analytics_meta` (
      `k` varchar(32) CHARACTER SET ascii NOT NULL,
      `v` varchar(255) CHARACTER SET ascii NOT NULL,
      PRIMARY KEY (`k`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];
const ANALYTICS_RAW_DDL = "CREATE TABLE IF NOT EXISTS `fork_analytics_raw` (
      `id` bigint unsigned NOT NULL AUTO_INCREMENT,
      `at` datetime NOT NULL,
      `uid` char(16) CHARACTER SET ascii NOT NULL,
      `feature` varchar(40) CHARACTER SET ascii NOT NULL,
      `action` varchar(24) CHARACTER SET ascii NOT NULL,
      `n` int unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`id`),
      KEY `at` (`at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

// ---- configuration (constants from docker/config.php, else the environment) ----

function analytics_setting($name) {
    return defined($name) ? constant($name) : getenv($name);
}

/** ANALYTICS_ENABLED: anything but an explicit false/0/off/no means on */
function analytics_enabled() {
    if (defined('ANALYTICS_ENABLED') && is_bool(ANALYTICS_ENABLED)) return ANALYTICS_ENABLED;
    $raw = analytics_setting('ANALYTICS_ENABLED');
    if ($raw === false || $raw === null || $raw === '') return true;
    $v = filter_var($raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $v !== false;
}

/** ANALYTICS_DAYS: days counters are kept and how often the salt is replaced (1-3650, default 90) */
function analytics_days() {
    $raw = analytics_setting('ANALYTICS_DAYS');
    if ($raw === false || $raw === null || !is_numeric($raw)) return ANALYTICS_DEFAULT_DAYS;
    return max(1, min(ANALYTICS_MAX_DAYS, (int) $raw));
}

/** ANALYTICS_RAW_DAYS: days single events are also kept for debugging (0-90, default 0 = not stored) */
function analytics_raw_days() {
    $raw = analytics_setting('ANALYTICS_RAW_DAYS');
    if ($raw === false || $raw === null || !is_numeric($raw)) return 0;
    return max(0, min(ANALYTICS_MAX_RAW_DAYS, (int) $raw));
}

// ---- schema ----

function analytics_ensure_schema(PDO $db) {
    foreach (ANALYTICS_DDL as $ddl) $db->exec($ddl);
    if (analytics_raw_days() > 0) $db->exec(ANALYTICS_RAW_DDL);
}

/** Run $fn; on a missing table (42S02) create the tables and run it again */
function analytics_run(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        analytics_ensure_schema($db);
        return $fn();
    }
}

// ---- catalog ----

/**
 * The event whitelist from the feature catalog: [featureId => ['actions' => [action => true], 'use' => [action => true]]].
 * Internal ids (e.g. "app") get only their own actions. Empty array when the file is missing or broken (nothing accepted).
 */
function analytics_catalog($path = ANALYTICS_CATALOG) {
    static $cache = [];
    if (isset($cache[$path])) return $cache[$path];
    $out = [];
    $json = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
    if (is_array($json) && isset($json['features']) && is_array($json['features'])) {
        foreach ($json['features'] as $f) {
            if (!is_array($f) || !isset($f['id']) || !is_string($f['id']) || !preg_match(ANALYTICS_FEATURE_RE, $f['id'])) continue;
            $use = [];
            foreach (array_merge(ANALYTICS_USE_ACTIONS, isset($f['use']) && is_array($f['use']) ? $f['use'] : []) as $a) {
                if (is_string($a) && preg_match(ANALYTICS_ACTION_RE, $a)) $use[$a] = true;
            }
            $actions = $use;
            foreach (ANALYTICS_GENERIC_ACTIONS as $a) $actions[$a] = true;
            $out[$f['id']] = ['actions' => $actions, 'use' => $use];
        }
        foreach (isset($json['internal']) && is_array($json['internal']) ? $json['internal'] : [] as $id) {
            if (!is_string($id) || !isset(ANALYTICS_INTERNAL_ACTIONS[$id])) continue;
            $actions = array_fill_keys(ANALYTICS_INTERNAL_ACTIONS[$id], true);
            $out[$id] = ['actions' => $actions, 'use' => []];
        }
    } else {
        error_log('analytics: cannot read the feature catalog ' . $path);
    }
    return $cache[$path] = $out;
}

function analytics_allowed(array $catalog, $feature, $action) {
    return is_string($feature) && is_string($action) && preg_match(ANALYTICS_ACTION_RE, $action) === 1
        && isset($catalog[$feature]) && isset($catalog[$feature]['actions'][$action]);
}

function analytics_is_use(array $catalog, $feature, $action) {
    return isset($catalog[$feature]['use'][$action]);
}

// ---- request body ----

/**
 * The counters of a request body: {"t": token, "e": [{"f": feature, "a": action, "n": count}, ...]}.
 * Returns ['token' => string, 'entries' => [[feature, action, n], ...]] with unknown features/actions dropped, duplicates
 * merged, counts clamped to 1..ANALYTICS_MAX_COUNT and at most ANALYTICS_MAX_ENTRIES entries; null when the body is not
 * that shape or too large.
 */
function analytics_parse($body, array $catalog) {
    if (!is_string($body) || $body === '' || strlen($body) > ANALYTICS_MAX_BODY) return null;
    $data = json_decode($body, true, 4);
    if (!is_array($data) || !isset($data['e']) || !is_array($data['e']) || !array_is_list($data['e'])) return null;
    $token = isset($data['t']) && is_string($data['t']) ? $data['t'] : '';
    $merged = [];
    foreach (array_slice($data['e'], 0, ANALYTICS_MAX_ENTRIES) as $e) {
        if (!is_array($e)) continue;
        $f = $e['f'] ?? null;
        $a = $e['a'] ?? null;
        if (!analytics_allowed($catalog, $f, $a)) continue;
        $n = isset($e['n']) && is_numeric($e['n']) ? (int) $e['n'] : 1;
        $n = max(1, min(ANALYTICS_MAX_COUNT, $n));
        $key = $f . '.' . $a;
        $merged[$key] = [$f, $a, min(ANALYTICS_MAX_COUNT, ($merged[$key][2] ?? 0) + $n)];
    }
    return ['token' => $token, 'entries' => array_values($merged)];
}

/**
 * Whether a POST may be recorded: the session's analytics token (hash_equals) and, when the browser says, same origin
 * (Origin host = Host, Sec-Fetch-Site = same-origin). $server: $_SERVER.
 */
function analytics_request_ok($sessionToken, $token, array $server) {
    if (!is_string($sessionToken) || strlen($sessionToken) < 32 || !is_string($token) || !hash_equals($sessionToken, $token)) return false;
    $site = isset($server['HTTP_SEC_FETCH_SITE']) ? strtolower((string) $server['HTTP_SEC_FETCH_SITE']) : '';
    if ($site !== '' && $site !== 'same-origin') return false;
    if (!empty($server['HTTP_ORIGIN'])) {
        $o = parse_url((string) $server['HTTP_ORIGIN']);
        if (!is_array($o) || empty($o['host'])) return false;
        $originHost = strtolower($o['host'] . (isset($o['port']) ? ':' . $o['port'] : ''));
        if ($originHost !== strtolower(isset($server['HTTP_HOST']) ? (string) $server['HTTP_HOST'] : '')) return false;
    }
    return true;
}

// ---- pseudonymous ids ----

/**
 * The current salt (32 raw bytes), replaced when older than $days days. Stored as one row "YYYY-MM-DD:<hex>"; a
 * replacement is a compare-and-swap on that row, so two requests at once agree on one new salt and the old one is gone.
 */
function analytics_salt(PDO $db, $days = null, $now = null) {
    $days = $days === null ? analytics_days() : max(1, (int) $days);
    $now = $now === null ? time() : (int) $now;
    return analytics_run($db, function () use ($db, $days, $now) {
        for ($i = 0; $i < 3; $i++) {
            $stmt = $db->prepare("SELECT v FROM fork_analytics_meta WHERE k = 'salt'");
            $stmt->execute();
            $row = $stmt->fetchColumn();
            $fresh = gmdate('Y-m-d', $now) . ':' . bin2hex(random_bytes(32));
            if ($row === false) {
                $db->prepare("INSERT IGNORE INTO fork_analytics_meta (k, v) VALUES ('salt', ?)")->execute([$fresh]);
                continue;   // read back what won
            }
            $parts = explode(':', (string) $row, 2);
            $since = strtotime($parts[0] . ' 00:00:00 UTC');
            if (count($parts) === 2 && strlen($parts[1]) === 64 && $since !== false && $now - $since < $days * 86400) {
                return hex2bin($parts[1]);
            }
            $db->prepare("UPDATE fork_analytics_meta SET v = ? WHERE k = 'salt' AND v = ?")->execute([$fresh, $row]);
        }
        throw new RuntimeException('analytics: could not settle the salt');
    });
}

/** 8 bytes of HMAC-SHA256 as 16 hex characters */
function analytics_hash($salt, $kind, $id) {
    return substr(hash_hmac('sha256', $kind . ':' . $id, $salt), 0, 16);
}

// ---- limits ----

/**
 * Count a request of this user against ANALYTICS_RATE_MAX per ANALYTICS_RATE_WINDOW (a window starts with the first request
 * after the last one ended). True when it may be recorded. A table row per user (pseudonymous uid), not the session: the
 * endpoint reads its session with read_and_close and can't write to it, and APCu isn't in the image.
 */
function analytics_rate_ok(PDO $db, $uid, $now = null) {
    $now = $now === null ? time() : (int) $now;
    $at = gmdate('Y-m-d H:i:s', $now);
    $expired = gmdate('Y-m-d H:i:s', $now - ANALYTICS_RATE_WINDOW);
    return analytics_run($db, function () use ($db, $uid, $at, $expired) {
        $db->prepare('INSERT INTO fork_analytics_rate (uid, windowStart, n) VALUES (?, ?, 1)
            ON DUPLICATE KEY UPDATE n = IF(windowStart <= ?, 1, n + 1), windowStart = IF(windowStart <= ?, VALUES(windowStart), windowStart)')
            ->execute([$uid, $at, $expired, $expired]);
        $stmt = $db->prepare('SELECT n FROM fork_analytics_rate WHERE uid = ?');
        $stmt->execute([$uid]);
        return (int) $stmt->fetchColumn() <= ANALYTICS_RATE_MAX;
    });
}

/** Whether the user turned usage statistics off (Settings > General: options.usageStats.enabled === false, stored in
 *  upstream's preferences table). The browser stops sending then; this also drops what an old tab still sends. */
function analytics_opted_out(PDO $db, $accountID) {
    $stmt = $db->prepare('SELECT options FROM preferences WHERE userID = ?');
    $stmt->execute([(int) $accountID]);
    $json = $stmt->fetchColumn();
    if (!is_string($json) || $json === '') return false;
    $o = json_decode($json, true);
    return is_array($o) && isset($o['usageStats']) && is_array($o['usageStats'])
        && array_key_exists('enabled', $o['usageStats']) && $o['usageStats']['enabled'] === false;
}

/** The browser's key for its once-a-day marks: opaque, per account, not the stored uid */
function analytics_client_key(PDO $db, $accountID) {
    return analytics_hash(analytics_salt($db), 'client', (int) $accountID);
}

// ---- writing ----

/**
 * Add the counters for one account. $entries from analytics_parse; $mask: the session's mask (only its hash is stored, for
 * "masks using"). Returns the number of counters written; 0 on any error (logged).
 */
function analytics_record(PDO $db, $accountID, $mask, array $entries, $now = null, $catalog = null) {
    try {
        if (!analytics_enabled() || (int) $accountID <= 0 || !$entries) return 0;
        $catalog = $catalog === null ? analytics_catalog() : $catalog;
        $now = $now === null ? time() : (int) $now;
        $day = gmdate('Y-m-d', $now);
        $at = gmdate('Y-m-d H:i:00', $now);
        $minute = (int) gmdate('G', $now) * 60 + (int) gmdate('i', $now);
        $salt = analytics_salt($db, null, $now);
        $uid = analytics_hash($salt, 'account', (int) $accountID);
        $maskHash = is_string($mask) && $mask !== '' ? analytics_hash($salt, 'mask', $mask) : '';
        $raw = analytics_raw_days() > 0;
        if (!analytics_rate_ok($db, $uid, $now)) return 0;
        return analytics_run($db, function () use ($db, $catalog, $entries, $day, $at, $minute, $uid, $maskHash, $raw) {
            $daily = $db->prepare('INSERT INTO fork_analytics_daily (day, feature, action, uid, n, firstMinute) VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE n = LEAST(n + VALUES(n), ' . ANALYTICS_MAX_DAILY . ')');
            $user = $db->prepare('INSERT INTO fork_analytics_user (uid, feature, action, firstAt, lastAt, n) VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE lastAt = VALUES(lastAt), n = LEAST(n + VALUES(n), 4000000000)');
            $masks = $db->prepare('INSERT IGNORE INTO fork_analytics_mask (day, maskHash, feature) VALUES (?, ?, ?)');
            $rawStmt = $raw ? $db->prepare('INSERT INTO fork_analytics_raw (at, uid, feature, action, n) VALUES (?, ?, ?, ?, ?)') : null;
            $db->beginTransaction();
            try {
                $written = 0;
                foreach ($entries as $e) {
                    list($f, $a, $n) = $e;
                    if (!analytics_allowed($catalog, $f, $a)) continue;
                    $n = max(1, min(ANALYTICS_MAX_COUNT, (int) $n));
                    $daily->execute([$day, $f, $a, $uid, $n, $minute]);
                    $user->execute([$uid, $f, $a, $at, $at, $n]);
                    if ($maskHash !== '' && analytics_is_use($catalog, $f, $a)) $masks->execute([$day, $maskHash, $f]);
                    if ($rawStmt) $rawStmt->execute([$at, $uid, $f, $a, $n]);
                    $written++;
                }
                $db->commit();
                return $written;
            } catch (Throwable $e) {
                if ($db->inTransaction()) $db->rollBack();
                throw $e;
            }
        });
    } catch (Throwable $e) {
        error_log('analytics: ' . $e->getMessage());
        return 0;
    }
}

// ---- retention ----

/**
 * Delete rows older than the retention, ANALYTICS_PRUNE_BATCH at a time. Returns the number of rows deleted. Never creates
 * a table: only the tables that exist are pruned (so a server with analytics off stays without them). An expired salt is
 * replaced (analytics on) or just deleted (analytics off), so old rows can't be linked to anyone either way.
 */
function analytics_prune(PDO $db, $days = null, $rawDays = null) {
    $days = $days === null ? analytics_days() : max(1, (int) $days);
    $rawDays = $rawDays === null ? analytics_raw_days() : max(0, (int) $rawDays);
    $deleted = 0;
    $batch = function ($sql) use ($db, &$deleted) {
        try {
            for ($i = 0; $i < ANALYTICS_PRUNE_ROUNDS; $i++) {
                $n = (int) $db->exec($sql);
                $deleted += $n;
                if ($n < ANALYTICS_PRUNE_BATCH) break;
            }
        } catch (PDOException $e) {
            if ($e->getCode() !== '42S02') throw $e;   // no such table: nothing to prune
        }
    };
    try {
        $limit = ' LIMIT ' . ANALYTICS_PRUNE_BATCH;
        $batch('DELETE FROM fork_analytics_daily WHERE day < DATE_SUB(UTC_DATE(), INTERVAL ' . $days . ' DAY)' . $limit);
        $batch('DELETE FROM fork_analytics_mask WHERE day < DATE_SUB(UTC_DATE(), INTERVAL ' . $days . ' DAY)' . $limit);
        $batch('DELETE FROM fork_analytics_user WHERE lastAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ' . $days . ' DAY)' . $limit);
        $batch('DELETE FROM fork_analytics_rate WHERE windowStart < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)' . $limit);
        // Raw events: kept $rawDays days; with raw storage off the whole table goes (if it exists)
        if ($rawDays < 1) {
            $db->exec('DROP TABLE IF EXISTS fork_analytics_raw');
        } else {
            $batch('DELETE FROM fork_analytics_raw WHERE at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ' . $rawDays . ' DAY)' . $limit);
        }
        $row = false;
        try {
            $row = $db->query("SELECT v FROM fork_analytics_meta WHERE k = 'salt'")->fetchColumn();
        } catch (PDOException $e) {
            if ($e->getCode() !== '42S02') throw $e;
        }
        if ($row !== false) {
            $since = strtotime(substr((string) $row, 0, 10) . ' 00:00:00 UTC');
            if ($since === false || time() - $since >= $days * 86400) {
                if (analytics_enabled()) {
                    analytics_salt($db, $days);   // replaces it
                } else {
                    $db->prepare("DELETE FROM fork_analytics_meta WHERE k = 'salt' AND v = ?")->execute([$row]);
                }
            }
        }
    } catch (Throwable $e) {
        error_log('analytics prune: ' . $e->getMessage());
    }
    return $deleted;
}
