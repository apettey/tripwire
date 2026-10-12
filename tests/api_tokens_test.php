<?php
// Fork-owned: REST API personal access tokens against the dev stack (needs its MySQL and the app container's nginx/PHP; no EVE login
// or ESI: sessions are written for fixture characters).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/api_tokens_test.php
// 1. api/tokens.inc.php: creating (format, only the SHA-256 stored, validation, 10 active tokens per user), verifying (wrong secret,
//    unknown id, revoked, expired), the access re-check (lost access, blocked, banned, alliance-only masks), the mask being the
//    token's own (a maskID parameter naming another mask is refused), read-only (writes refused), the rate limit, lastUsed throttling.
// 2. api/v1.inc.php: every endpoint, the data of the token's mask only, validation, notes sanitised, hole types equal tools/wormholes.json.
// 3. Over HTTP: public/api_tokens.php (CSRF, X-Requested-With, content type, Origin, the session's mask, IDOR on revoke, mask admins,
//    the audit entries), public/api.php with a Bearer token (/api/v1, the old read endpoints, statistics refused), the old Basic login.
// Fixtures use fake ids (990xxx characters / corporations, masks 990101.0 and 990102.0) and are deleted at the end.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('APITOKENS_BASE') ?: 'http://127.0.0.1';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$mysql = $db;
require_once(__DIR__ . '/../api/tokens.inc.php');
require_once(__DIR__ . '/../api/v1.inc.php');
require_once(__DIR__ . '/../audit/audit.inc.php');
require_once(__DIR__ . '/../password_hash.php');

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
    global $failures, $count;
    $count++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}

// ---- fixtures ----
const MASK_A = '990101.0';    // owned by OWNER; corporation CORP_M has access
const MASK_B = '990102.0';    // somebody else's; nobody of ours has access
const OWNER = 990101, MEMBER = 990102, MEMBER2 = 990103, OUTSIDER = 990104, CORPADMIN = 990105, STRANGER = 990106, LIMITER = 990107;
const CORP_O = 99010010, CORP_M = 99010020, CORP_X = 99010030;
const SYSTEM = 31000005, SYSTEM2 = 31000006;
$chars = [
    [OWNER, 'Tok Owner', CORP_O, 0], [MEMBER, 'Tok Member', CORP_M, 0], [MEMBER2, 'Tok Member Two', CORP_M, 0],
    [OUTSIDER, 'Tok Outsider', CORP_X, 0], [CORPADMIN, 'Tok CorpAdmin', CORP_M, 1], [STRANGER, 'Tok Stranger', CORP_X, 0],
    [LIMITER, 'Tok Limiter', CORP_M, 0],
];
$uid = [];   // characterID => accounts.id (tokens belong to the account)
function cleanup() {
    global $db, $chars;
    $ids = implode(',', array_map(function ($c) { return (int) $c[0]; }, $chars));
    $uids = $db->query("SELECT userID FROM characters WHERE characterID IN ($ids)")->fetchAll(PDO::FETCH_COLUMN);
    foreach ($uids as $u) {
        foreach (['fork_api_rate' => 'tokenID IN (SELECT id FROM fork_api_tokens WHERE userID = ' . (int) $u . ')', 'fork_api_tokens' => 'userID = ' . (int) $u] as $t => $w) {
            try { $db->exec("DELETE FROM $t WHERE $w"); } catch (PDOException $e) { if ($e->getCode() !== '42S02') throw $e; }
        }
    }
    foreach ([MASK_A, MASK_B, CORP_M . '.2'] as $m) {
        foreach (['fork_mask_admins', 'fork_mask_blocks', 'fork_mask_defaults', 'fork_mask_audit', 'fork_structures', 'signatures', 'comments', '`groups`', 'masks'] as $t) {
            try { $db->prepare("DELETE FROM $t WHERE maskID = ?")->execute([$m]); } catch (PDOException $e) { if ($e->getCode() !== '42S02') throw $e; }
        }
    }
    $db->exec("DELETE FROM characters WHERE characterID IN ($ids)");
    $db->exec("DELETE FROM accounts WHERE username LIKE 'apitok-test-%'");
    foreach (glob('/var/lib/php/session/sess_apitokentest*') ?: [] as $f) @unlink($f);
}
cleanup();
maskadmin_ensure_schema($db);
api_token_ensure_schema($db);
structures_schema($db);
$hasher = new PasswordHash(8, false);
foreach ($chars as $i => $c) {
    $db->prepare('INSERT INTO accounts (username, password) VALUES (?, ?)')->execute(['apitok-test-' . $i, $hasher->HashPassword('pw-' . $c[0])]);
    $uid[$c[0]] = (int) $db->lastInsertId();
    $db->prepare('INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName, admin) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$uid[$c[0]], $c[0], $c[1], $c[2], 'Corp ' . $c[2], $c[3]]);
}
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_A, 'Tok mask A', OWNER]);
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_B, 'Tok mask B', STRANGER]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_A, CORP_M]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_B, CORP_X]);
$sig = $db->prepare('INSERT INTO signatures (signatureID, systemID, type, name, bookmark, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID) VALUES (?, ?, ?, ?, ?, 86400, 1, \'Tok Owner\', 1, \'Tok Owner\', ?)');
$sig->execute(['ABC123', SYSTEM, 'wormhole', 'static', 'bm1', MASK_A]);   $sigA1 = (int) $db->lastInsertId();
$sig->execute(['DEF456', SYSTEM2, 'wormhole', 'K162 side', '', MASK_A]);  $sigA2 = (int) $db->lastInsertId();
$sig->execute(['GHI789', SYSTEM, 'relic', 'a relic', '', MASK_A]);
$sig->execute(['ZZZ999', SYSTEM, 'wormhole', 'other mask', '', MASK_B]);  $sigB1 = (int) $db->lastInsertId();
$sig->execute(['YYY888', SYSTEM2, 'wormhole', 'other mask 2', '', MASK_B]); $sigB2 = (int) $db->lastInsertId();
$db->prepare('INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([$sigA1, $sigA2, 'B274', 'initial', 'stable', 'destab', MASK_A]);
$db->prepare('INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([$sigB1, $sigB2, 'C140', 'initial', 'critical', 'critical', MASK_B]);
$comment = $db->prepare('INSERT INTO comments (systemID, comment, created, createdByID, createdByName, modifiedByID, modifiedByName, maskID) VALUES (?, ?, UTC_TIMESTAMP(), 1, \'Tok Owner\', 1, \'Tok Owner\', ?)');
$comment->execute([SYSTEM, '<p>Hello <b>world</b><script>alert(1)</script><img src=x onerror=alert(2)></p>', MASK_A]);
$comment->execute([SYSTEM, 'secret of mask B', MASK_B]);
$struct = $db->prepare('INSERT INTO fork_structures (maskID, systemID, typeName, kind, name, state, timerKind, timerAt, firstSeenAt, lastSeenAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())');
$struct->execute([MASK_A, SYSTEM, 'Astrahus', 'upwell', 'Mine', 'reinforced', 'armor']);
$struct->execute([MASK_B, SYSTEM, 'Fortizar', 'upwell', 'Theirs', 'reinforced', 'armor']);

$now = time();
$mk = function ($who, $mask = MASK_A, $days = null, $at = null) use ($db, $uid, $now) {
    list($ok, $token, $status, $row) = api_token_create($db, $uid[$who], $who, $mask, 'test token', $days, $at ?? $now);
    if (!$ok) { fwrite(STDERR, "fixture token failed: $token\n"); exit(1); }
    return [$token, $row];
};
$server = function ($token, $method = 'GET', $ip = '203.0.113.7') {
    return ['HTTP_AUTHORIZATION' => 'Bearer ' . $token, 'REQUEST_METHOD' => $method, 'REMOTE_ADDR' => $ip];
};

// ---- 1. library ----
// parsing
check('parse: ok', api_token_parse('twp_12_' . str_repeat('ab', 32)), ['12', str_repeat('ab', 32)]);
foreach (['', 'twp_0_' . str_repeat('ab', 32), 'twp_12_' . str_repeat('AB', 32), 'twp_12_' . str_repeat('ab', 31), 'twp_12_' . str_repeat('ab', 33), 'tw_12_' . str_repeat('ab', 32),
    'twp_012_' . str_repeat('ab', 32), "twp_12_" . str_repeat('ab', 32) . "\n", 'twp_-1_' . str_repeat('ab', 32)] as $i => $bad) {
    check('parse: refuses #' . $i, api_token_parse($bad), null);
}
check('parse: not a string', api_token_parse(['x']), null);
check('bearer: header', api_token_bearer(['HTTP_AUTHORIZATION' => 'Bearer abc']), 'abc');
check('bearer: scheme is case-insensitive', api_token_bearer(['HTTP_AUTHORIZATION' => 'bearer abc']), 'abc');
check('bearer: redirect header', api_token_bearer(['REDIRECT_HTTP_AUTHORIZATION' => 'Bearer abc']), 'abc');
check('bearer: Basic is not a token request', api_token_bearer(['HTTP_AUTHORIZATION' => 'Basic dXNlcjpwdw==']), null);
check('bearer: none', api_token_bearer([]), null);
check('bearer: empty', api_token_bearer(['HTTP_AUTHORIZATION' => 'Bearer']), '');

// create
list($tokenM, $rowM) = $mk(MEMBER);
$parsed = api_token_parse($tokenM);
check('create: format', [$parsed !== null, $parsed[0] === (string) $rowM['id']], [true, true]);
check('create: only the SHA-256 is stored', [$rowM['tokenHash'] === hash('sha256', $parsed[1]), strlen($rowM['tokenHash']), strpos(json_encode($rowM), $parsed[1])], [true, 64, false]);
check('create: row', [(int) $rowM['userID'] === $uid[MEMBER], (int) $rowM['characterID'], $rowM['maskID'], $rowM['scope'], $rowM['revokedAt'], $rowM['expiresAt'], $rowM['lastUsedAt']], [true, MEMBER, MASK_A, 'read', null, null, null]);
check('create: tokens differ', $mk(MEMBER)[0] !== $tokenM, true);
$public = api_token_public($rowM, $now, true);
check('public: no hash, no secret', [array_key_exists('tokenHash', $public), strpos(json_encode($public), $parsed[1]), $public['hint']], [false, false, 'twp_' . $rowM['id'] . '_…']);
check('public: mask admin view has no IP', array_key_exists('lastUsedIP', api_token_public($rowM, $now, false)), false);
check('create: empty name', api_token_create($db, $uid[MEMBER], MEMBER, MASK_A, "  \n ", null, $now)[0], false);
check('create: name cleaned', api_token_create($db, $uid[MEMBER2], MEMBER2, MASK_A, "  my\x00 bot\n" . str_repeat('x', 80), null, $now)[3]['name'], 'my bot ' . str_repeat('x', 33));
foreach ([0, -1, 366, '30', 1.5] as $i => $days) check('create: bad lifetime #' . $i, api_token_create($db, $uid[MEMBER2], MEMBER2, MASK_A, 'x', $days, $now)[2], 400);
check('create: scope write refused', api_token_create($db, $uid[MEMBER2], MEMBER2, MASK_A, 'x', null, $now, 'write')[2], 400);
check('create: expiry stored', api_token_create($db, $uid[MEMBER2], MEMBER2, MASK_A, 'x', 30, $now)[3]['expiresAt'], gmdate('Y-m-d H:i:s', $now + 30 * 86400));
check('create: mask without access', api_token_create($db, $uid[OUTSIDER], OUTSIDER, MASK_A, 'x', null, $now)[2], 403);
check('create: mask of another corporation', api_token_create($db, $uid[MEMBER], MEMBER, MASK_B, 'x', null, $now)[2], 403);
check('create: another character\'s personal mask', api_token_create($db, $uid[MEMBER], MEMBER, OWNER . '.1', 'x', null, $now)[2], 403);
check('create: own personal mask', api_token_create($db, $uid[MEMBER], MEMBER, MEMBER . '.1', 'x', null, $now)[0], true);
check('create: own corporation mask', api_token_create($db, $uid[MEMBER], MEMBER, CORP_M . '.2', 'x', null, $now)[0], true);
check('create: alliance mask refused (alliance access can not be re-checked)', api_token_create($db, $uid[MEMBER], MEMBER, '99011111.3', 'x', null, $now)[2], 403);
check('create: a mask spelled with leading zeros is stored canonical', api_token_create($db, $uid[MEMBER], MEMBER, '0990101.0', 'x', null, $now)[3]['maskID'], MASK_A);
check('create: junk mask', api_token_create($db, $uid[MEMBER], MEMBER, "990101.0' OR 1=1", 'x', null, $now)[2], 400);

// the limit: 10 active per user (LIMITER has its own tokens)
check('limit: none yet', api_token_active_count($db, $uid[LIMITER], $now), 0);
for ($i = 0; $i < API_TOKEN_MAX_ACTIVE; $i++) $mk(LIMITER);
check('limit: at the maximum', api_token_active_count($db, $uid[LIMITER], $now), 10);
list($ok, $msg, $status) = api_token_create($db, $uid[LIMITER], LIMITER, MASK_A, 'one too many', null, $now);
check('limit: the 11th is refused', [$ok, $status], [false, 409]);
$extra = api_token_list_user($db, $uid[LIMITER]);
api_token_revoke($db, $extra[0]['id'], $uid[LIMITER], LIMITER, $now);
check('limit: revoking frees one', api_token_create($db, $uid[LIMITER], LIMITER, MASK_A, 'fits again', null, $now)[0], true);
$db->prepare('UPDATE fork_api_tokens SET expiresAt = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', $now - 10), $extra[1]['id']]);
check('limit: expired ones do not count', api_token_active_count($db, $uid[LIMITER], $now), 9);
check('limit: other users are not affected', api_token_active_count($db, $uid[OWNER], $now), 0);
check('limit: another user can still create', api_token_create($db, $uid[OWNER], OWNER, MASK_A, 'mine', null, $now)[0], true);

// verify
list($tokenV, $rowV) = $mk(MEMBER2);
[$id, $secret] = api_token_parse($tokenV);
check('verify: ok', api_token_verify($db, $id, $secret, $now)[1], 'ok');
check('verify: wrong secret', api_token_verify($db, $id, str_repeat('0', 64), $now), [null, 'invalid']);
check('verify: unknown id', api_token_verify($db, '999999999', $secret, $now), [null, 'invalid']);
check('verify: the secret of another token', api_token_verify($db, $id, api_token_parse($tokenM)[1], $now), [null, 'invalid']);
check('verify: no expiry set', api_token_verify($db, $id, $secret, $now + 400 * 86400)[1], 'ok');
$expiring = $mk(MEMBER2, MASK_A, 1)[0];
[$eid, $esecret] = api_token_parse($expiring);
check('verify: before expiry', api_token_verify($db, $eid, $esecret, $now + 86400 - 1)[1], 'ok');
check('verify: at expiry', api_token_verify($db, $eid, $esecret, $now + 86400)[1], 'expired');
$revokeMe = $mk(MEMBER2)[0];
[$rid, $rsecret] = api_token_parse($revokeMe);
check('revoke: own token', api_token_revoke($db, $rid, $uid[MEMBER2], MEMBER2, $now)[0], true);
check('verify: revoked', api_token_verify($db, $rid, $rsecret, $now)[1], 'revoked');
check('revoke: again is harmless', api_token_revoke($db, $rid, $uid[MEMBER2], MEMBER2, $now + 5)[0], true);
check('revoke: the first revocation time stays', api_token_get($db, $rid)['revokedAt'], gmdate('Y-m-d H:i:s', $now));
check('revoke: unknown id', api_token_revoke($db, 123456789, $uid[MEMBER2], MEMBER2, $now)[2], 404);

// authenticate
$auth = function ($token, $method = 'GET', $request = [], $at = null, $ip = '203.0.113.7') use ($db, $server, $now) {
    return api_token_authenticate($db, $server($token, $method, $ip), $request, $at ?? $now);
};
list($tokenA, $rowA) = $mk(MEMBER);
$r = $auth($tokenA);
check('auth: ok', [$r['status'], $r['mask'], $r['character']['characterName'], $r['error']], [200, MASK_A, 'Tok Member', null]);
check('auth: rate headers', array_values(array_filter($r['headers'], function ($h) { return strpos($h, 'X-RateLimit-Limit') === 0; })), ['X-RateLimit-Limit: ' . api_token_rate_limit()]);
check('auth: no header', api_token_authenticate($db, ['REQUEST_METHOD' => 'GET'], [], $now)['status'], 401);
check('auth: garbage', $auth('nonsense')['status'], 401);
check('auth: wrong secret', $auth('twp_' . $rowA['id'] . '_' . str_repeat('0', 64))['status'], 401);
check('auth: 401 challenges', $auth('nonsense')['headers'][0], 'WWW-Authenticate: Bearer realm="Tripwire", error="invalid_token"');
check('auth: revoked', [$auth($revokeMe)['status'], $auth($revokeMe)['error']], [401, 'Token revoked']);
check('auth: expired', [$auth($expiring, 'GET', [], $now + 2 * 86400)['status'], $auth($expiring, 'GET', [], $now + 2 * 86400)['error']], [401, 'Token expired']);

// read-only
foreach (['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as $m) check('auth: ' . $m . ' refused', [$auth($tokenA, $m)['status'], in_array('Allow: GET, HEAD', $auth($tokenA, $m)['headers'], true)], [405, true]);
check('auth: HEAD allowed', $auth($tokenA, 'HEAD')['status'], 200);
check('auth: lowercase method refused too', $auth($tokenA, 'post')['status'], 405);

// the mask is the token's
check('mask: same mask in the request', $auth($tokenA, 'GET', ['maskID' => MASK_A])['status'], 200);
check('mask: empty maskID ignored', $auth($tokenA, 'GET', ['maskID' => ''])['status'], 200);
check('mask: another mask', $auth($tokenA, 'GET', ['maskID' => MASK_B])['status'], 403);
check('mask: another mask is not read either', $auth($tokenA, 'GET', ['maskID' => MASK_B])['mask'], MASK_A);
check('mask: non-canonical spelling of the same mask', $auth($tokenA, 'GET', ['maskID' => '990101.00'])['status'], 403);
check('mask: array', $auth($tokenA, 'GET', ['maskID' => [MASK_A]])['status'], 403);
check('mask: someone else\'s mask by injection', $auth($tokenA, 'GET', ['maskID' => MASK_A . ' OR 1=1'])['status'], 403);

// access is re-checked on every request
$db->prepare('DELETE FROM `groups` WHERE maskID = ? AND eveID = ?')->execute([MASK_A, CORP_M]);
check('access: corporation lost the mask', [$auth($tokenA)['status'], $auth($tokenA)['error']], [403, 'The token\'s character no longer has access to its mask']);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_A, CORP_M]);
check('access: and gets it back', $auth($tokenA)['status'], 200);
$db->prepare('UPDATE characters SET corporationID = ? WHERE characterID = ?')->execute([CORP_X, MEMBER]);
check('access: character moved to another corporation', $auth($tokenA)['status'], 403);
$db->prepare('UPDATE characters SET corporationID = ? WHERE characterID = ?')->execute([CORP_M, MEMBER]);
$ownerActor = ['id' => OWNER, 'name' => 'Tok Owner'];
maskadmin_block($db, MASK_A, $ownerActor, MEMBER, 'test');
check('access: blocked in Mask Admin', [$auth($tokenA)['status'], $auth($tokenA)['error']], [403, 'The token\'s character is blocked from its mask']);
maskadmin_unblock($db, MASK_A, $ownerActor, MEMBER);
check('access: unblocked', $auth($tokenA)['status'], 200);
$db->prepare('UPDATE accounts SET ban = 1 WHERE id = ?')->execute([$uid[MEMBER]]);
check('access: banned account', $auth($tokenA)['status'], 403);
$db->prepare('UPDATE accounts SET ban = 0 WHERE id = ?')->execute([$uid[MEMBER]]);
$db->prepare('UPDATE characters SET ban = 1 WHERE characterID = ?')->execute([MEMBER]);
check('access: banned character', $auth($tokenA)['status'], 403);
$db->prepare('UPDATE characters SET ban = 0 WHERE characterID = ?')->execute([MEMBER]);
check('access: ban lifted', $auth($tokenA)['status'], 200);
$tokenPersonal = api_token_create($db, $uid[MEMBER2], MEMBER2, MEMBER2 . '.1', 'p', null, $now)[1];
check('access: personal mask works', $auth($tokenPersonal)['mask'], MEMBER2 . '.1');
// the character row is gone -> the token is useless (the foreign key would delete the account's tokens only with the account)
$charRow = $db->query('SELECT * FROM characters WHERE characterID = ' . MEMBER2)->fetch(PDO::FETCH_ASSOC);
$db->exec('DELETE FROM characters WHERE characterID = ' . MEMBER2);
check('access: character removed', $auth($tokenPersonal)['status'], 403);
$db->prepare('INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName, admin) VALUES (?, ?, ?, ?, ?, ?)')
    ->execute([$charRow['userID'], $charRow['characterID'], $charRow['characterName'], $charRow['corporationID'], $charRow['corporationName'], $charRow['admin']]);
// a token whose row says another character than the account's
$db->prepare('UPDATE fork_api_tokens SET characterID = ? WHERE id = ?')->execute([OUTSIDER, $rowA['id']]);
check('access: token tied to a character the account does not have', $auth($tokenA)['status'], 403);
$db->prepare('UPDATE fork_api_tokens SET characterID = ? WHERE id = ?')->execute([MEMBER, $rowA['id']]);

// the rate limit
list($tokenR, $rowR) = $mk(OWNER);
$minute = intdiv($now, 60) * 60 + 5;   // a fixed point inside a minute, whatever the clock is
check('rate: default limit is 60/min', api_token_rate_limit(), 60);
check('rate: first request', $auth($tokenR, 'GET', [], $minute)['status'], 200);
$db->prepare('UPDATE fork_api_rate SET hits = 58 WHERE tokenID = ?')->execute([$rowR['id']]);
$codes = [];
foreach ([0, 1, 2, 3] as $i) $codes[] = $auth($tokenR, 'GET', [], $minute + 2)['status'];
check('rate: 59th, 60th pass, 61st and 62nd are 429', $codes, [200, 200, 429, 429]);
$over = $auth($tokenR, 'GET', [], $minute + 2);
check('rate: 429 headers', [$over['error'], in_array('Retry-After: ' . (intdiv($now, 60) * 60 + 60 - ($minute + 2)), $over['headers'], true), in_array('X-RateLimit-Remaining: 0', $over['headers'], true)], ['Rate limit exceeded: 60 requests per minute per token', true, true]);
check('rate: a write counts and is refused', $auth($tokenR, 'POST', [], $minute + 2)['status'], 429);
check('rate: the next minute starts again', $auth($tokenR, 'GET', [], $minute + 60)['status'], 200);
check('rate: per token', $auth($tokenA, 'GET', [], $minute + 2)['status'], 200);
check('rate: counter rows', (int) $db->query('SELECT COUNT(*) FROM fork_api_rate WHERE tokenID = ' . (int) $rowR['id'])->fetchColumn() >= 2, true);
check('rate: custom limit', api_token_rate_hit($db, $rowR['id'], $minute + 120, 2), [true, 2, 1, intdiv($minute + 120, 60) * 60 + 60]);
api_token_rate_hit($db, $rowR['id'], $minute + 120, 2);
check('rate: custom limit exceeded', api_token_rate_hit($db, $rowR['id'], $minute + 120, 2)[0], false);
// a failed login costs nothing
$before = (int) $db->query('SELECT COUNT(*) FROM fork_api_rate')->fetchColumn();
$auth('twp_' . $rowR['id'] . '_' . str_repeat('1', 64), 'GET', [], $minute + 300);
check('rate: a wrong secret writes nothing', (int) $db->query('SELECT COUNT(*) FROM fork_api_rate')->fetchColumn(), $before);

// lastUsed is throttled
list($tokenU, $rowU) = $mk(OWNER);
check('touch: never used', api_token_get($db, $rowU['id'])['lastUsedAt'], null);
$auth($tokenU, 'GET', [], $now, '198.51.100.1');
$u1 = api_token_get($db, $rowU['id']);
check('touch: first use', [$u1['lastUsedAt'], $u1['lastUsedIP']], [gmdate('Y-m-d H:i:s', $now), '198.51.100.1']);
$auth($tokenU, 'GET', [], $now + 60, '198.51.100.1');
check('touch: not written again within 5 minutes', api_token_get($db, $rowU['id'])['lastUsedAt'], gmdate('Y-m-d H:i:s', $now));
$auth($tokenU, 'GET', [], $now + 120, '198.51.100.2');
check('touch: a new address is written at once', [api_token_get($db, $rowU['id'])['lastUsedAt'], api_token_get($db, $rowU['id'])['lastUsedIP']], [gmdate('Y-m-d H:i:s', $now + 120), '198.51.100.2']);
$auth($tokenU, 'GET', [], $now + 120 + 301, '198.51.100.2');
check('touch: written after 5 minutes', api_token_get($db, $rowU['id'])['lastUsedAt'], gmdate('Y-m-d H:i:s', $now + 421));
$auth($tokenU, 'GET', [], $now + 900, 'not an address');
check('touch: junk REMOTE_ADDR stored as nothing', api_token_get($db, $rowU['id'])['lastUsedIP'], null);

// the password switch
putenv('TRIPWIRE_API_PASSWORD_AUTH');
check('password auth: on by default', api_password_auth_enabled(), true);
foreach (['false', '0', 'no', 'off', 'FALSE'] as $v) { putenv('TRIPWIRE_API_PASSWORD_AUTH=' . $v); check('password auth: off for ' . $v, api_password_auth_enabled(), false); }
putenv('TRIPWIRE_API_PASSWORD_AUTH=true');
check('password auth: on for true', api_password_auth_enabled(), true);
putenv('TRIPWIRE_API_PASSWORD_AUTH');

// ---- 2. endpoints ----
$ctxFor = function ($token) use ($auth) { return $auth($token); };
$ctx = $ctxFor($tokenA);
list($st, $who) = api_v1_route($db, $ctx, [], [], $now);
check('v1: who', [$st, $who['mask'], $who['scope'], $who['token']['name'], $who['character']['name']], [200, MASK_A, 'read', 'test token', 'Tok Member']);
check('v1: who has no secret', strpos(json_encode($who), 'tokenHash'), false);
list($st, $chain) = api_v1_route($db, $ctx, ['chain'], [], $now);
check('chain: status, systems', [$st, array_column($chain['systems'], 'systemID')], [200, [SYSTEM, SYSTEM2]]);
check('chain: signature counts', [$chain['systems'][0]['signatures'], $chain['systems'][0]['wormholes']], [2, 1]);
check('chain: one hole, not the other mask\'s', count($chain['holes']), 1);
$hole = $chain['holes'][0];
check('chain: hole', [$hole['type'], $hole['parent'], $hole['life'], $hole['mass'], $hole['size'], $hole['maxJumpMass'], $hole['leadsTo']], ['B274', 'initial', 'stable', 'destab', 'L', 375000000, 'High-Sec']);
check('chain: hole ends', [$hole['from']['systemID'], $hole['from']['signatureID'], $hole['from']['name'], $hole['to']['systemID'], $hole['to']['signatureID']], [SYSTEM, 'ABC123', 'static', SYSTEM2, 'DEF456']);
check('chain: nothing of the other mask', strpos(json_encode($chain), 'ZZZ999'), false);
list($st, $sigs) = api_v1_route($db, $ctx, ['signatures'], [], $now);
check('signatures: all of the mask', [$st, count($sigs['signatures']), array_values(array_unique(array_column($sigs['signatures'], 'systemID')))], [200, 3, [SYSTEM, SYSTEM2]]);
check('signatures: other mask hidden', strpos(json_encode($sigs), 'other mask'), false);
check('signatures: row', [$sigs['signatures'][0]['signatureID'], $sigs['signatures'][0]['type'], $sigs['signatures'][0]['bookmark'], $sigs['signatures'][0]['lifeLength'], $sigs['signatures'][0]['createdBy'], preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', $sigs['signatures'][0]['lifeLeft'])], ['ABC123', 'wormhole', 'bm1', 86400, 'Tok Owner', 1]);
list($st, $sigs1) = api_v1_route($db, $ctx, ['signatures'], ['systemID' => (string) SYSTEM2], $now);
check('signatures: one system', [$st, array_column($sigs1['signatures'], 'signatureID')], [200, ['DEF456']]);
foreach (['abc', '12345678', '30000000 OR 1=1', '29999999', '33000000', ['x']] as $i => $bad) check('signatures: bad systemID #' . $i, api_v1_route($db, $ctx, ['signatures'], ['systemID' => $bad], $now)[0], 400);
list($st, $str) = api_v1_route($db, $ctx, ['structures'], [], $now);
check('structures: the mask\'s only', [$st, array_column($str['structures'], 'name')], [200, ['Mine']]);
check('structures: fields', [$str['structures'][0]['typeName'], $str['structures'][0]['state'], $str['structures'][0]['timerKind'], is_int($str['structures'][0]['timerAt'])], ['Astrahus', 'reinforced', 'armor', true]);
list($st, $str1) = api_v1_route($db, $ctx, ['structures'], ['systemID' => (string) SYSTEM], $now);
check('structures: one system, with the gone list', [$st, count($str1['structures']), $str1['gone']], [200, 1, []]);
list($st, $str2) = api_v1_route($db, $ctx, ['structures'], ['systemID' => (string) SYSTEM2], $now);
check('structures: a system without any', [$st, $str2['structures']], [200, []]);
list($st, $timers) = api_v1_route($db, $ctx, ['timers'], [], $now);
check('timers: the mask\'s', [$st, array_column($timers['timers'], 'name'), $timers['serverTime']], [200, ['Mine'], $now]);
list($st, $notes) = api_v1_route($db, $ctx, ['notes'], [], $now);
check('notes: the mask\'s only', [$st, count($notes['notes']), strpos(json_encode($notes), 'secret of mask B')], [200, 1, false]);
check('notes: sanitised', [strpos($notes['notes'][0]['html'], '<script'), strpos($notes['notes'][0]['html'], 'onerror'), strpos($notes['notes'][0]['html'], '<b>world</b>') !== false], [false, false, true]);
check('notes: alias comments', api_v1_route($db, $ctx, ['comments'], ['systemID' => (string) SYSTEM], $now)[1]['notes'][0]['createdBy'], 'Tok Owner');
check('notes: another system has none', api_v1_route($db, $ctx, ['notes'], ['systemID' => (string) SYSTEM2], $now)[1]['notes'], []);
check('v1: unknown endpoint', api_v1_route($db, $ctx, ['statistics'], [], $now)[0], 404);
check('v1: no sub paths', api_v1_route($db, $ctx, ['chain', 'x'], [], $now)[0], 404);
check('v1: trailing slash', api_v1_route($db, $ctx, ['chain', ''], [], $now)[0], 200);
$ctxB = $ctxFor($mk(STRANGER, MASK_B)[0]);
check('v1: the other mask\'s token reads the other mask', [array_column(api_v1_route($db, $ctxB, ['signatures'], [], $now)[1]['signatures'], 'signatureID'), api_v1_route($db, $ctxB, ['notes'], [], $now)[1]['notes'][0]['html'], array_column(api_v1_route($db, $ctxB, ['structures'], [], $now)[1]['structures'], 'name')], [['ZZZ999', 'YYY888'], 'secret of mask B', ['Theirs']]);
// hole types: a copy of tools/wormholes.json
if (is_file('tools/wormholes.json')) {
    $src = json_decode(file_get_contents('tools/wormholes.json'), true);
    $copy = api_v1_hole_types();
    $same = count($src) === count($copy);
    foreach ($src as $k => $v) $same = $same && isset($copy[$k]) && $copy[$k] === ['jump' => $v['jump'], 'mass' => $v['mass'], 'life' => $v['life'], 'leadsTo' => $v['leadsTo']];
    check('hole types: api/wormhole-types.json equals tools/wormholes.json', $same, true);
}
check('size classes', [api_v1_size(5000000), api_v1_size(62000000), api_v1_size(375000000), api_v1_size(1000000000), api_v1_size(2000000000), api_v1_size(0)], ['S', 'M', 'L', 'VL', 'XL', null]);

// ---- 3. HTTP ----
function make_session($name, array $data) {
    $sid = 'apitokentest' . $name;
    $path = '/var/lib/php/session/sess_' . $sid;
    $payload = '';
    foreach ($data as $k => $v) $payload .= $k . '|' . serialize($v);
    file_put_contents($path, $payload);
    @chown($path, 'www-data');
    @chmod($path, 0600);
    return $sid;
}
function http($method, $path, $sid, $body = null, array $headers = []) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    if ($sid) $headers[] = 'Cookie: PHPSESSID=' . $sid;
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $size = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    $head = substr((string) $text, 0, $size);
    $body = substr((string) $text, $size);
    return [$status, json_decode($body, true), $body, $head];
}
function sess($name, $char, $charName, $corp, $mask, $admin = 0) {
    global $uid;
    return make_session($name, ['userID' => $uid[$char], 'mask' => $mask, 'characterID' => $char, 'characterName' => $charName, 'corporationID' => $corp, 'allianceID' => null, 'admin' => $admin, 'super' => 0]);
}
function post($sid, $csrf, array $data, array $extra = []) {
    $headers = array_merge(['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf], $extra);
    return http('POST', 'api_tokens.php', $sid, json_encode($data), $headers);
}
function api($path, $token, $method = 'GET', array $extra = []) {
    return http($method, 'api/' . ltrim($path, '/'), null, null, array_merge($token === null ? [] : ['Authorization: Bearer ' . $token], $extra));
}
$sMember = sess('member', MEMBER, 'Tok Member', CORP_M, MASK_A);
$sMember2 = sess('member2', MEMBER2, 'Tok Member Two', CORP_M, MASK_A);
$sOwner = sess('owner', OWNER, 'Tok Owner', CORP_O, MASK_A);
$sOutsider = sess('outsider', OUTSIDER, 'Tok Outsider', CORP_X, MASK_A);   // a session for a mask it may not use: the guard drops it to the corp mask
$sCorpAdmin = sess('corpadmin', CORPADMIN, 'Tok CorpAdmin', CORP_M, CORP_M . '.2', 1);
$sStranger = sess('stranger', STRANGER, 'Tok Stranger', CORP_X, MASK_B);

check('http: no session', http('GET', 'api_tokens.php', null)[0], 403);
list($st, $out) = http('GET', 'api_tokens.php', $sMember);
check('http: state', [$st, $out['enabled'], $out['max'], $out['mask']['id'], $out['mask']['label'], $out['canCreate'], $out['admin'], $out['maskTokens'], strlen($out['csrf'])], [200, true, 10, MASK_A, 'Tok mask A', true, false, null, 64]);
check('http: your tokens, with your IP field, never a hash', [count($out['tokens']) > 0, array_key_exists('lastUsedIP', $out['tokens'][0]), strpos(json_encode($out), 'tokenHash')], [true, true, false]);
$csrf = $out['csrf'];
check('http: unsupported method', http('PUT', 'api_tokens.php', $sMember)[0], 405);

// CSRF and request checks on every write
$body = ['mode' => 'create', 'name' => 'http token'];
check('csrf: missing token', http('POST', 'api_tokens.php', $sMember, json_encode($body), ['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest'])[0], 403);
check('csrf: wrong token', post($sMember, str_repeat('0', 64), $body)[0], 403);
check('csrf: another session\'s token', post($sMember, http('GET', 'api_tokens.php', $sMember2)[1]['csrf'], $body)[0], 403);
check('csrf: no X-Requested-With', http('POST', 'api_tokens.php', $sMember, json_encode($body), ['Content-Type: application/json', 'X-CSRF-Token: ' . $csrf])[0], 400);
check('csrf: form content type', http('POST', 'api_tokens.php', $sMember, http_build_query($body), ['Content-Type: application/x-www-form-urlencoded', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf])[0], 415);
check('csrf: cross-origin', post($sMember, $csrf, $body, ['Origin: https://evil.example'])[0], 403);
check('csrf: same origin passes', post($sMember, $csrf, $body, ['Origin: ' . $base])[0], 200);
check('csrf: invalid JSON', http('POST', 'api_tokens.php', $sMember, '{nope', ['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf])[0], 400);
check('csrf: unknown mode', post($sMember, $csrf, ['mode' => 'delete'])[0], 400);
$countBefore = count(http('GET', 'api_tokens.php', $sMember)[1]['tokens']);
check('csrf: a GET with revoke parameters changes nothing', [http('GET', 'api_tokens.php?mode=revoke&id=' . $rowA['id'], $sMember)[0], count(http('GET', 'api_tokens.php', $sMember)[1]['tokens']), api_token_get($db, $rowA['id'])['revokedAt']], [200, $countBefore, null]);
check('csrf: bad lifetime type', post($sMember, $csrf, ['mode' => 'create', 'name' => 'x', 'expiresDays' => '30'])[0], 400);

// creating over HTTP, using the token
$before = count(http('GET', 'api_tokens.php', $sMember2)[1]['tokens']);
list($st, $out) = post($sMember2, http('GET', 'api_tokens.php', $sMember2)[1]['csrf'], ['mode' => 'create', 'name' => 'http token', 'expiresDays' => 30]);
check('create: status, token returned once', [$st, preg_match('/^twp_\d+_[0-9a-f]{64}$/', $out['token'])], [200, 1]);
$httpToken = $out['token'];
check('create: listed afterwards, without the secret', [count($out['tokens']), strpos(json_encode($out['tokens']), substr($httpToken, -64)), $out['tokens'][0]['name'], $out['tokens'][0]['mask'], $out['tokens'][0]['expiresAt'] !== null], [$before + 1, false, 'http token', MASK_A, true]);
list($st, $list) = http('GET', 'api_tokens.php', $sMember2);
check('create: a later GET has no token string', strpos(json_encode($list), substr($httpToken, -64)), false);
check('create: the session\'s mask, not a request value', post($sMember2, $list['csrf'], ['mode' => 'create', 'name' => 'sneaky', 'mask' => MASK_B, 'maskID' => MASK_B])[1]['tokens'][0]['mask'], MASK_A);
check('create: the outsider got the corp mask, not mask A', http('GET', 'api_tokens.php', $sOutsider)[1]['mask']['id'], CORP_X . '.2');
list($st, $out) = api('v1', $httpToken);
check('use: GET /api/v1', [$st, $out['mask'], $out['character']['name']], [200, MASK_A, 'Tok Member Two']);
$head = api('v1', $httpToken)[3];
check('use: headers', [preg_match('/X-RateLimit-Limit: 60/i', $head), preg_match('/Cache-Control: no-store/i', $head)], [1, 1]);
list($st, $out) = api('v1/chain', $httpToken);
check('use: chain', [$st, count($out['holes']), $out['mask']], [200, 1, MASK_A]);
check('use: signatures', array_column(api('v1/signatures?systemID=' . SYSTEM, $httpToken)[1]['signatures'], 'signatureID'), ['ABC123', 'GHI789']);
check('use: structures', array_column(api('v1/structures', $httpToken)[1]['structures'], 'name'), ['Mine']);
check('use: timers', array_column(api('v1/timers', $httpToken)[1]['timers'], 'name'), ['Mine']);
check('use: notes', api('v1/notes', $httpToken)[1]['notes'][0]['createdBy'], 'Tok Owner');
check('use: bad systemID', api('v1/signatures?systemID=abc', $httpToken)[0], 400);
check('use: unknown path', api('v1/nothing', $httpToken)[0], 404);
check('use: no token on /api/v1', [api('v1/chain', null)[0], (bool) preg_match('/WWW-Authenticate: Bearer/i', api('v1/chain', null)[3])], [401, true]);
check('use: a password is not accepted on /api/v1', http('GET', 'api/v1/chain', null, null, ['Authorization: Basic ' . base64_encode('apitok-test-1:pw-' . MEMBER)])[0], 401);
check('use: bad token', api('v1/chain', 'twp_1_' . str_repeat('0', 64))[0], 401);
check('use: another mask asked for', api('v1/chain?maskID=' . MASK_B, $httpToken)[0], 403);
check('use: the same mask asked for', api('v1/chain?maskID=' . MASK_A, $httpToken)[0], 200);
foreach (['POST', 'PUT', 'DELETE', 'PATCH'] as $m) check('use: ' . $m . ' refused', api('v1/chain', $httpToken, $m)[0], 405);
check('use: POST to a legacy endpoint refused too', api('signatures', $httpToken, 'POST')[0], 405);
// the old read endpoints with a token
list($st, $legacy) = api('signatures?systemID=' . SYSTEM, $httpToken);
check('legacy+token: signatures of the token\'s mask', [$st, array_column($legacy, 'signatureID')], [200, ['ABC123', 'DEF456', 'GHI789']]);   // the old query also returns every wormhole signature of the mask
check('legacy+token: wormholes', array_column(api('wormholes', $httpToken)[1], 'type'), ['B274']);
check('legacy+token: comments', count(api('comments', $httpToken)[1]), 1);
check('legacy+token: another mask asked for', api('signatures?maskID=' . MASK_B, $httpToken)[0], 403);
check('legacy+token: statistics are not available to tokens', api('statistics', $httpToken)[0], 404);
check('legacy+token: unknown', api('whatever', $httpToken)[0], 404);

// the old Basic login still works (TRIPWIRE_API_PASSWORD_AUTH defaults to on)
$basic = ['Authorization: Basic ' . base64_encode('apitok-test-1:pw-' . MEMBER)];
list($st, $out) = http('GET', 'api/signatures?maskID=' . MASK_A . '&systemID=' . SYSTEM2, null, null, $basic);
check('basic: still works', [$st, is_array($out) ? array_column($out, 'signatureID') : $out], [200, ['ABC123', 'DEF456']]);
check('basic: wrong password', http('GET', 'api/signatures?maskID=' . MASK_A, null, null, ['Authorization: Basic ' . base64_encode('apitok-test-1:wrong')])[0], 401);
check('basic: no credentials', http('GET', 'api/signatures?maskID=' . MASK_A, null)[0], 401);

// revoking: IDOR
$tokensOf = function ($sid) { return http('GET', 'api_tokens.php', $sid)[1]; };
$csrfOf = function ($sid) use ($tokensOf) { return $tokensOf($sid)['csrf']; };
list($st, $out) = post($sMember, $csrf, ['mode' => 'create', 'name' => 'victim token']);
$victim = $out['token'];
$victimID = (int) $out['created'];
check('idor: another member can not revoke it', [post($sMember2, $csrfOf($sMember2), ['mode' => 'revoke', 'id' => $victimID])[0], api('v1', $victim)[0]], [404, 200]);
check('idor: nor can a stranger of another mask', [post($sStranger, $csrfOf($sStranger), ['mode' => 'revoke', 'id' => $victimID])[0], api('v1', $victim)[0]], [404, 200]);
check('idor: nor the admin of another mask', [post($sOutsider, $csrfOf($sOutsider), ['mode' => 'revoke', 'id' => $victimID])[0], api('v1', $victim)[0]], [404, 200]);
check('idor: an unknown id looks the same', post($sMember2, $csrfOf($sMember2), ['mode' => 'revoke', 'id' => 987654321])[0], 404);
check('idor: bad ids', [post($sMember, $csrf, ['mode' => 'revoke', 'id' => 0])[0], post($sMember, $csrf, ['mode' => 'revoke', 'id' => '1 OR 1=1'])[0], post($sMember, $csrf, ['mode' => 'revoke'])[0]], [400, 400, 400]);
list($st, $mt) = http('GET', 'api_tokens.php', $sOwner);
check('mask admin: the owner sees the mask\'s tokens, with owners, without IPs', [$st, $mt['admin'], count($mt['maskTokens']) > 0, in_array('Tok Member', array_column($mt['maskTokens'], 'owner'), true), array_key_exists('lastUsedIP', $mt['maskTokens'][0]), strpos(json_encode($mt), 'tokenHash')], [200, true, true, true, false, false]);
check('mask admin: a member sees none', http('GET', 'api_tokens.php', $sMember)[1]['maskTokens'], null);
check('mask admin: the owner does not see the other mask\'s tokens', array_values(array_unique(array_column($mt['maskTokens'], 'mask'))), [MASK_A]);
list($st, $out) = post($sOwner, $mt['csrf'], ['mode' => 'revoke', 'id' => $victimID]);
check('mask admin: the owner revokes a member\'s token', [$st, $out['revoked'], api('v1', $victim)[0], api('v1', $victim)[1]['error']], [200, $victimID, 401, 'Token revoked']);
check('mask admin: revoking again is harmless', post($sOwner, $mt['csrf'], ['mode' => 'revoke', 'id' => $victimID])[0], 200);
// a corp admin is admin of the corp mask
$corpTok = api_token_create($db, $uid[MEMBER2], MEMBER2, CORP_M . '.2', 'corp mask token', null, time());
list($st, $ca) = http('GET', 'api_tokens.php', $sCorpAdmin);
check('mask admin: a corp admin sees the corporation mask\'s tokens', [$st, $ca['admin'], in_array('corp mask token', array_column($ca['maskTokens'], 'name'), true), $ca['mask']['label']], [200, true, true, 'Corp ' . CORP_M . ' (corporation mask)']);
check('mask admin: a corp admin revokes one', post($sCorpAdmin, $ca['csrf'], ['mode' => 'revoke', 'id' => (int) $corpTok[3]['id']])[0], 200);
check('mask admin: and it is dead', api('v1', $corpTok[1])[0], 401);
check('mask admin: a corp admin has no say over mask A', post($sCorpAdmin, $ca['csrf'], ['mode' => 'revoke', 'id' => (int) api_token_list_user($db, $uid[MEMBER])[0]['id']])[0], 404);
// own token
check('revoke: own token over HTTP', post($sMember2, $csrfOf($sMember2), ['mode' => 'revoke', 'id' => (int) api_token_parse($httpToken)[0]])[0], 200);
check('revoke: it stops working at once', api('v1', $httpToken)[0], 401);
// a member who loses the mask loses the token without anybody revoking it
$lostTok = $mk(MEMBER)[0];
check('lost access: works first', api('v1', $lostTok)[0], 200);
$db->prepare('DELETE FROM `groups` WHERE maskID = ? AND eveID = ?')->execute([MASK_A, CORP_M]);
check('lost access: refused over HTTP', [api('v1', $lostTok)[0], api('v1/chain', $lostTok)[1]['error']], [403, 'The token\'s character no longer has access to its mask']);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_A, CORP_M]);

// audit entries
$audit = $db->prepare('SELECT action, actorName, targetName, detail FROM fork_mask_audit WHERE maskID = ? AND action LIKE \'token-%\' ORDER BY id');
$audit->execute([MASK_A]);
$entries = $audit->fetchAll(PDO::FETCH_ASSOC);
check('audit: creates are logged', count(array_filter($entries, function ($e) { return $e['action'] === 'token-create' && $e['actorName'] === 'Tok Member Two' && $e['detail'] === '"http token"'; })), 1);
check('audit: an admin\'s revoke names the owner', count(array_filter($entries, function ($e) { return $e['action'] === 'token-revoke' && $e['actorName'] === 'Tok Owner' && $e['targetName'] === 'Tok Member' && $e['detail'] === '"victim token"'; })), 1);
check('audit: revoking twice logs once', count(array_filter($entries, function ($e) { return $e['action'] === 'token-revoke' && $e['detail'] === '"victim token"'; })), 1);
check('audit: an own revoke is logged', count(array_filter($entries, function ($e) { return $e['action'] === 'token-revoke' && $e['actorName'] === 'Tok Member Two' && $e['targetName'] === 'Tok Member Two'; })), 1);
check('audit: no secret anywhere', strpos(json_encode($entries), 'twp_'), false);
$q = audit_query($db, MASK_A, ['entity' => 'mask', 'action' => 'token-create'] + audit_filters([]));
check('audit: the Audit tab reads them', count($q['rows']) >= 1 && $q['rows'][0]['action'] === 'token-create', true);
check('audit: filter accepts the new kinds', audit_filters(['kind' => 'mask.token-revoke'])['action'], 'token-revoke');
$corpAudit = $db->prepare('SELECT COUNT(*) FROM fork_mask_audit WHERE maskID = ? AND action = \'token-revoke\'');
$corpAudit->execute([CORP_M . '.2']);
check('audit: a corp mask revoke is logged under that mask', (int) $corpAudit->fetchColumn(), 1);

cleanup();
echo $failures ? "\n$failures of $count checks FAILED\n" : "OK: $count checks passed\n";
exit($failures ? 1 : 0);
