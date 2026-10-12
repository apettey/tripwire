<?php
// Fork-owned: personal access tokens for the REST API (see docker/README.md#rest-api).
//
// A token is "twp_<id>_<64 hex>": the id finds the row, the 32 random bytes are the secret. Only SHA-256 of the secret is stored, so
// a database dump can not be used as a token; the full token is shown once, when it is created. One token = one character
// (the user's) = exactly one mask, scope "read" (the only scope for now).
//
// Every request re-checks that the token's character still has access to its mask (same rule as the session mask guard,
// tripwire_mask_allowed) and is not blocked from it (Mask Admin), so leaving the corporation, losing a mask grant or a block
// takes the token's access away without anybody revoking it. A character reaching a mask only through its alliance can not hold
// a token: Tripwire stores no alliance per character, so that access can not be re-checked on an API request (fails closed).
//
// The functions take the database and the time explicitly (no session, no globals) so tests/api_tokens_test.php can run them
// without a web server. The HTTP side is public/api_tokens.php (management, session + CSRF) and api/token-auth.php (the API).

require_once(__DIR__ . '/../mask-guard.inc.php');
require_once(__DIR__ . '/../maskadmin/maskadmin.inc.php');

const API_TOKEN_DDL = [
    "CREATE TABLE IF NOT EXISTS `fork_api_tokens` (
      `id` bigint unsigned NOT NULL AUTO_INCREMENT,
      `userID` int NOT NULL,
      `characterID` int NOT NULL,
      `name` varchar(40) NOT NULL,
      `maskID` decimal(12,1) NOT NULL,
      `scope` varchar(10) NOT NULL DEFAULT 'read',
      `tokenHash` char(64) NOT NULL,
      `createdAt` datetime NOT NULL,
      `expiresAt` datetime DEFAULT NULL,
      `lastUsedAt` datetime DEFAULT NULL,
      `lastUsedIP` varchar(45) DEFAULT NULL,
      `revokedAt` datetime DEFAULT NULL,
      `revokedBy` int DEFAULT NULL,
      PRIMARY KEY (`id`),
      KEY `user` (`userID`, `revokedAt`),
      KEY `mask` (`maskID`, `revokedAt`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_api_rate` (
      `tokenID` bigint unsigned NOT NULL,
      `windowStart` int unsigned NOT NULL,
      `hits` int unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`tokenID`, `windowStart`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

const API_TOKEN_PREFIX = 'twp_';
const API_TOKEN_SCOPES = ['read'];
const API_TOKEN_MAX_ACTIVE = 10;        // not revoked, not expired, per user
const API_TOKEN_NAME_MAX = 40;
const API_TOKEN_MAX_DAYS = 365;         // longest lifetime a token can be given; no expiry is allowed too
const API_TOKEN_TOUCH_SECONDS = 300;    // lastUsedAt / lastUsedIP are written at most this often
const API_TOKEN_RATE_DEFAULT = 60;      // requests per token and minute (TRIPWIRE_API_RATE_LIMIT)
const API_TOKEN_REVOKED_KEEP_DAYS = 30; // revoked rows are deleted after this

function api_token_ensure_schema(PDO $db) {
    foreach (API_TOKEN_DDL as $ddl) $db->exec($ddl);
}

/** Run $fn; if a fork table is missing, create the tables and run it once more (tables are created on first use) */
function api_token_run(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        api_token_ensure_schema($db);
        return $fn();
    }
}

function api_token_utc($unix) { return gmdate('Y-m-d H:i:s', (int) $unix); }
function api_token_unix($datetime) { return $datetime === null || $datetime === '' ? null : (int) strtotime($datetime . ' UTC'); }
function api_token_iso($datetime) { $t = api_token_unix($datetime); return $t === null ? null : gmdate('Y-m-d\TH:i:s\Z', $t); }

/** Requests per token and minute: TRIPWIRE_API_RATE_LIMIT (docker/config.php), 1..100000, default 60 */
function api_token_rate_limit() {
    $raw = defined('TRIPWIRE_API_RATE_LIMIT') ? TRIPWIRE_API_RATE_LIMIT : getenv('TRIPWIRE_API_RATE_LIMIT');
    if ($raw === false || $raw === null || trim((string) $raw) === '' || !is_numeric($raw)) return API_TOKEN_RATE_DEFAULT;
    return max(1, min(100000, (int) $raw));
}

/** Whether the old HTTP Basic (account password) authentication still works: TRIPWIRE_API_PASSWORD_AUTH, default false (off) */
function api_password_auth_enabled() {
    if (defined('TRIPWIRE_API_PASSWORD_AUTH')) return (bool) TRIPWIRE_API_PASSWORD_AUTH;
    $raw = getenv('TRIPWIRE_API_PASSWORD_AUTH');
    return $raw !== false && in_array(strtolower(trim($raw)), ['1', 'true', 'yes', 'on'], true);
}

/** One line of user text, control characters gone, cut to $max characters */
function api_token_clean_name($text) {
    if (!is_string($text)) return '';
    $text = preg_replace('/[\x00-\x1F\x7F\x{2028}\x{2029}]+/u', ' ', $text);
    if ($text === null) return '';   // invalid UTF-8
    $text = trim(preg_replace('/\s+/u', ' ', $text));
    return mb_substr($text, 0, API_TOKEN_NAME_MAX, 'UTF-8');
}

// ---- the token string ----

/** [id, secret] of "twp_<id>_<64 lowercase hex>", or null. Not case-folded: the secret is hex as issued. */
function api_token_parse($token) {
    if (!is_string($token) || strlen($token) > 100) return null;
    if (!preg_match('/^twp_([1-9][0-9]{0,18})_([0-9a-f]{64})$/D', $token, $m)) return null;
    return [$m[1], $m[2]];
}

/** The token a request presents: the value after "Bearer " of the Authorization header ('' = none, null = another scheme) */
function api_token_bearer(array $server) {
    $header = isset($server['HTTP_AUTHORIZATION']) ? $server['HTTP_AUTHORIZATION'] : (isset($server['REDIRECT_HTTP_AUTHORIZATION']) ? $server['REDIRECT_HTTP_AUTHORIZATION'] : '');
    if (!is_string($header) || !preg_match('/^Bearer(?:\s+(\S*))?\s*$/i', $header, $m)) return null;
    return isset($m[1]) ? $m[1] : '';
}

function api_token_hash($secret) { return hash('sha256', (string) $secret); }

// ---- access ----

/**
 * Whether the token's character still reaches the token's mask: [true, ['characterID', 'characterName', 'corporationID', 'mask']] or
 * [false, reason]. The mask rule is the session guard's (tripwire_mask_allowed), strict: the allowed mask must be the token's own.
 */
function api_token_access(PDO $db, array $token) {
    $stmt = $db->prepare('SELECT c.characterID, c.characterName, c.corporationID, c.ban AS characterBan, a.ban AS accountBan
        FROM characters c INNER JOIN accounts a ON a.id = c.userID WHERE c.userID = ? AND c.characterID = ?');
    $stmt->execute([(int) $token['userID'], (int) $token['characterID']]);
    $c = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$c) return [false, 'The token\'s character no longer exists'];
    if ((int) $c['characterBan'] === 1 || (int) $c['accountBan'] === 1) return [false, 'The token\'s account is banned'];

    $mask = tripwire_mask_canonical((string) $token['maskID']);
    if ($mask === null) return [false, 'The token\'s mask is invalid'];
    $session = ['characterID' => (int) $c['characterID'], 'corporationID' => (int) $c['corporationID'], 'allianceID' => null];
    if (tripwire_mask_allowed($mask, $session, $db) !== $mask) return [false, 'The token\'s character no longer has access to its mask'];
    if (maskadmin_is_custom($mask) && maskadmin_run($db, function () use ($db, $mask, $c) { return maskadmin_is_blocked($db, $mask, $c['characterID']); })) {
        return [false, 'The token\'s character is blocked from its mask'];
    }
    return [true, ['characterID' => (int) $c['characterID'], 'characterName' => $c['characterName'], 'corporationID' => (int) $c['corporationID'], 'mask' => $mask]];
}

// ---- create, list, revoke ----

function api_token_columns() {
    return 'id, userID, characterID, name, maskID, scope, tokenHash, createdAt, expiresAt, lastUsedAt, lastUsedIP, revokedAt, revokedBy';
}

function api_token_is_expired(array $row, $now) {
    $expires = api_token_unix($row['expiresAt']);
    return $expires !== null && $expires <= $now;
}

/** Tokens of the user that are neither revoked nor expired */
function api_token_active_count(PDO $db, $userID, $now) {
    return api_token_run($db, function () use ($db, $userID, $now) {
        $stmt = $db->prepare('SELECT COUNT(*) FROM fork_api_tokens WHERE userID = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)');
        $stmt->execute([(int) $userID, api_token_utc($now)]);
        return (int) $stmt->fetchColumn();
    });
}

/**
 * Create a token for the user's character on $mask. Returns [ok, tokenOrMessage, httpStatus, row]; the token string is only in this
 * answer. $expiresDays: null = never expires, else 1..API_TOKEN_MAX_DAYS. The caller has checked who $userID / $characterID are
 * (the session); this checks that the character reaches $mask and the limits.
 */
function api_token_create(PDO $db, $userID, $characterID, $mask, $name, $expiresDays, $now, $scope = 'read') {
    $name = api_token_clean_name($name);
    if ($name === '') return [false, 'Give the token a name', 400, null];
    if (!in_array($scope, API_TOKEN_SCOPES, true)) return [false, 'Unknown scope', 400, null];
    if ($expiresDays !== null) {
        if (!is_int($expiresDays) || $expiresDays < 1 || $expiresDays > API_TOKEN_MAX_DAYS) return [false, 'The lifetime must be between 1 and ' . API_TOKEN_MAX_DAYS . ' days, or none', 400, null];
    }
    $canonical = tripwire_mask_canonical((string) $mask);
    if ($canonical === null) return [false, 'Invalid mask', 400, null];
    [$ok, $info] = api_token_access($db, ['userID' => $userID, 'characterID' => $characterID, 'maskID' => $canonical]);
    if (!$ok) {
        return [false, 'API tokens are not available for this mask (masks reached only through an alliance are not supported)', 403, null];
    }
    if (api_token_active_count($db, $userID, $now) >= API_TOKEN_MAX_ACTIVE) {
        return [false, 'You can have at most ' . API_TOKEN_MAX_ACTIVE . ' active API tokens: revoke one first', 409, null];
    }
    $secret = bin2hex(random_bytes(32));
    $expiresAt = $expiresDays === null ? null : api_token_utc($now + $expiresDays * 86400);
    $id = api_token_run($db, function () use ($db, $userID, $characterID, $name, $canonical, $scope, $secret, $now, $expiresAt) {
        $stmt = $db->prepare('INSERT INTO fork_api_tokens (userID, characterID, name, maskID, scope, tokenHash, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([(int) $userID, (int) $characterID, $name, $canonical, $scope, api_token_hash($secret), api_token_utc($now), $expiresAt]);
        return (int) $db->lastInsertId();
    });
    $row = api_token_get($db, $id);
    // opportunistic clean-up of old revoked rows
    if ($id % 20 === 0) api_token_prune($db, $now);
    return [true, API_TOKEN_PREFIX . $id . '_' . $secret, 201, $row];
}

function api_token_get(PDO $db, $id) {
    return api_token_run($db, function () use ($db, $id) {
        $stmt = $db->prepare('SELECT ' . api_token_columns() . ' FROM fork_api_tokens WHERE id = ?');
        $stmt->execute([(int) $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    });
}

/** The user's tokens that are not revoked, newest first */
function api_token_list_user(PDO $db, $userID) {
    return api_token_run($db, function () use ($db, $userID) {
        $stmt = $db->prepare('SELECT ' . api_token_columns() . ' FROM fork_api_tokens WHERE userID = ? AND revokedAt IS NULL ORDER BY id DESC LIMIT 50');
        $stmt->execute([(int) $userID]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    });
}

/** The tokens issued for the mask that are not revoked, with their owner's character name, newest first */
function api_token_list_mask(PDO $db, $mask) {
    return api_token_run($db, function () use ($db, $mask) {
        $stmt = $db->prepare('SELECT t.id, t.userID, t.characterID, t.name, t.maskID, t.scope, t.tokenHash, t.createdAt, t.expiresAt, t.lastUsedAt, t.lastUsedIP, t.revokedAt, t.revokedBy,
            c.characterName AS ownerName FROM fork_api_tokens t LEFT JOIN characters c ON c.characterID = t.characterID
            WHERE t.maskID = ? AND t.revokedAt IS NULL ORDER BY t.id DESC LIMIT 200');
        $stmt->execute([$mask]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    });
}

/** A token row as the browser gets it: never the hash, the IP only for the owner ($withIP) */
function api_token_public(array $row, $now, $withIP = false) {
    $out = [
        'id' => (int) $row['id'], 'name' => $row['name'], 'mask' => (string) $row['maskID'], 'scope' => $row['scope'],
        'createdAt' => api_token_iso($row['createdAt']), 'expiresAt' => api_token_iso($row['expiresAt']),
        'lastUsedAt' => api_token_iso($row['lastUsedAt']), 'expired' => api_token_is_expired($row, $now),
        'hint' => API_TOKEN_PREFIX . (int) $row['id'] . '_…',
    ];
    if ($withIP) $out['lastUsedIP'] = $row['lastUsedIP'];
    if (array_key_exists('ownerName', $row)) $out['owner'] = $row['ownerName'];
    return $out;
}

/**
 * May $characterID revoke this token? Its owner, or an admin of the token's mask (owner, corp admin or granted mask admin of that
 * mask, as Mask Admin; checked for the token's own mask, not for the session's).
 */
function api_token_may_revoke(PDO $db, array $token, $userID, $characterID, $allianceID = null) {
    if ((int) $token['userID'] === (int) $userID) return true;
    $mask = (string) $token['maskID'];
    return (bool) maskadmin_run($db, function () use ($db, $mask, $characterID, $allianceID) { return maskadmin_is_admin($db, $mask, $characterID, $allianceID); });
}

/** Revoke (idempotent). Returns [ok, message, httpStatus, row]: 404 for a token that does not exist and for one the caller may not touch. */
function api_token_revoke(PDO $db, $id, $userID, $characterID, $now, $allianceID = null) {
    $token = api_token_get($db, $id);
    if (!$token || !api_token_may_revoke($db, $token, $userID, $characterID, $allianceID)) return [false, 'No such token', 404, null];
    if ($token['revokedAt'] === null) {
        $stmt = $db->prepare('UPDATE fork_api_tokens SET revokedAt = ?, revokedBy = ? WHERE id = ? AND revokedAt IS NULL');
        $stmt->execute([api_token_utc($now), (int) $characterID, (int) $id]);
    }
    return [true, 'Revoked', 200, $token];
}

/** Delete revoked tokens older than API_TOKEN_REVOKED_KEEP_DAYS and rate-limit rows older than an hour */
function api_token_prune(PDO $db, $now) {
    try {
        api_token_run($db, function () use ($db, $now) {
            $db->prepare('DELETE FROM fork_api_tokens WHERE revokedAt IS NOT NULL AND revokedAt < ? LIMIT 1000')->execute([api_token_utc($now - API_TOKEN_REVOKED_KEEP_DAYS * 86400)]);
            $db->prepare('DELETE FROM fork_api_rate WHERE windowStart < ? LIMIT 5000')->execute([(int) $now - 3600]);
        });
    } catch (Throwable $e) {
        error_log('api tokens: ' . $e->getMessage());
    }
}

// ---- using a token ----

/**
 * The token row for a presented secret, or an error code. Constant-time: the hash is compared with hash_equals against a dummy hash
 * when the id is unknown, so a wrong id and a wrong secret take the same path.
 * @return array [row|null, 'ok'|'invalid'|'revoked'|'expired']
 */
function api_token_verify(PDO $db, $id, $secret, $now) {
    $row = api_token_get($db, $id);
    $expected = $row ? (string) $row['tokenHash'] : str_repeat('0', 64);
    $match = hash_equals($expected, api_token_hash($secret));
    if (!$row || !$match) return [null, 'invalid'];
    if ($row['revokedAt'] !== null) return [null, 'revoked'];
    if (api_token_is_expired($row, $now)) return [null, 'expired'];
    if (!in_array($row['scope'], API_TOKEN_SCOPES, true)) return [null, 'invalid'];
    return [$row, 'ok'];
}

/** Count one request of the token in the current minute. Returns [allowed, limit, remaining, resetAt (unix)] */
function api_token_rate_hit(PDO $db, $tokenID, $now, $limit = null) {
    $limit = $limit === null ? api_token_rate_limit() : (int) $limit;
    $window = intdiv((int) $now, 60) * 60;
    $hits = api_token_run($db, function () use ($db, $tokenID, $window) {
        $stmt = $db->prepare('INSERT INTO fork_api_rate (tokenID, windowStart, hits) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE hits = hits + 1');
        $stmt->execute([(int) $tokenID, $window]);
        $stmt = $db->prepare('SELECT hits FROM fork_api_rate WHERE tokenID = ? AND windowStart = ?');
        $stmt->execute([(int) $tokenID, $window]);
        return (int) $stmt->fetchColumn();
    });
    if (random_int(1, 200) === 1) api_token_prune($db, $now);
    return [$hits <= $limit, $limit, max(0, $limit - $hits), $window + 60];
}

/** lastUsedAt / lastUsedIP, written at most every API_TOKEN_TOUCH_SECONDS (or when the address changes) */
function api_token_touch(PDO $db, $tokenID, $ip, $now) {
    $ip = is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP) ? $ip : null;
    api_token_run($db, function () use ($db, $tokenID, $ip, $now) {
        $stmt = $db->prepare('UPDATE fork_api_tokens SET lastUsedAt = ?, lastUsedIP = ? WHERE id = ?
            AND (lastUsedAt IS NULL OR lastUsedAt < ? OR NOT (lastUsedIP <=> ?))');
        $stmt->execute([api_token_utc($now), $ip, (int) $tokenID, api_token_utc($now - API_TOKEN_TOUCH_SECONDS), $ip]);
    });
}

/**
 * Authenticate an API request that carries "Authorization: Bearer ...". $server = $_SERVER, $request = $_REQUEST (for a maskID).
 * Order: token valid (401) -> character still has access (403) -> rate limit (429) -> lastUsed -> method (405) -> mask parameter (403).
 * @return array ['status' => int, 'error' => ?string, 'headers' => string[], 'token' => ?row, 'mask' => ?string, 'character' => ?array]
 */
function api_token_authenticate(PDO $db, array $server, array $request, $now) {
    $fail = function ($status, $error, array $headers = []) {
        return ['status' => $status, 'error' => $error, 'headers' => $headers, 'token' => null, 'mask' => null, 'character' => null, 'rate' => null];
    };
    $challenge = 'WWW-Authenticate: Bearer realm="Tripwire"';
    $bearer = api_token_bearer($server);
    $parsed = $bearer === null ? null : api_token_parse($bearer);
    if ($parsed === null) return $fail(401, 'Invalid token', [$challenge . ', error="invalid_token"']);

    [$token, $why] = api_token_verify($db, $parsed[0], $parsed[1], $now);
    if ($token === null) {
        return $fail(401, $why === 'revoked' ? 'Token revoked' : ($why === 'expired' ? 'Token expired' : 'Invalid token'), [$challenge . ', error="invalid_token"']);
    }
    [$ok, $info] = api_token_access($db, $token);
    if (!$ok) return $fail(403, $info);

    [$allowed, $limit, $remaining, $reset] = api_token_rate_hit($db, $token['id'], $now);
    $rate = ['limit' => $limit, 'remaining' => $remaining, 'reset' => $reset];
    $headers = ['X-RateLimit-Limit: ' . $limit, 'X-RateLimit-Remaining: ' . $remaining, 'X-RateLimit-Reset: ' . $reset];
    $result = function ($status, $error, array $extra = []) use ($token, $info, $headers, $rate) {
        return ['status' => $status, 'error' => $error, 'headers' => array_merge($headers, $extra), 'token' => $token, 'mask' => $info['mask'], 'character' => $info, 'rate' => $rate];
    };
    if (!$allowed) return $result(429, 'Rate limit exceeded: ' . $limit . ' requests per minute per token', ['Retry-After: ' . max(1, $reset - (int) $now)]);

    api_token_touch($db, $token['id'], isset($server['REMOTE_ADDR']) ? $server['REMOTE_ADDR'] : null, $now);

    $method = isset($server['REQUEST_METHOD']) ? strtoupper((string) $server['REQUEST_METHOD']) : '';
    if ($method !== 'GET' && $method !== 'HEAD') return $result(405, 'Tokens are read-only: GET only', ['Allow: GET, HEAD']);

    // The mask is the token's. A maskID parameter (the old API needed one) is only accepted when it names that same mask.
    if (isset($request['maskID']) && $request['maskID'] !== '') {
        $asked = is_string($request['maskID']) ? tripwire_mask_canonical($request['maskID']) : null;
        if ($asked !== $info['mask']) return $result(403, 'This token is bound to mask ' . $info['mask'] . '; it can not read another mask');
    }
    return $result(200, null);
}
