<?php
// Fork-owned: several mask admins, blocking members and mask defaults against the dev stack (needs its MySQL and the app container's
// nginx/PHP; no EVE login or ESI: sessions are written for fixture characters).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/mask_admins_test.php
// 1. maskadmin/maskadmin.inc.php: levels, who may grant/revoke/block/unblock/remove/set defaults, protection of the owner and the
//    corp admins, blocked characters (session mask dropped), the checkAdmin() hook, the defaults validation.
// 2. public/mask_admins.php over HTTP: CSRF, X-Requested-With, content type, Origin, non-admins, the session's mask being the only
//    mask a request can touch (a "mask" in the body is ignored), a target of another mask refused, a blocked character's next
//    request, the blocked mask hidden from public/masks.php.
// Fixtures use fake ids (990xxx characters / corporations, masks 990001.0 and 990002.0) and are deleted at the end.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('MASKADMIN_BASE') ?: 'http://127.0.0.1';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$mysql = $db;
require_once(__DIR__ . '/../maskadmin/maskadmin.inc.php');

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
const MASK_A = '990001.0';    // owned by character OWNER; corp CORP_A and character DIRECT have access
const MASK_B = '990002.0';    // owned by corporation CORP_B (CORPADMIN is its Tripwire admin)
const OWNER = 990001, CORPADMIN = 990002, MEMBER1 = 990003, MEMBER2 = 990004, DIRECT = 990005, OUTSIDER = 990006, CORPUSER = 990007, GRANTED = 990008;
const CORP_A = 99000011, CORP_B = 99000020, CORP_X = 99000030, CORP_OWNER = 99000010;
$chars = [
    [OWNER, 'Test Owner', CORP_OWNER, 0], [CORPADMIN, 'Test CorpAdmin', CORP_B, 1], [MEMBER1, 'Test Member One', CORP_A, 0],
    [MEMBER2, 'Test Member Two', CORP_A, 0], [DIRECT, 'Test Direct', CORP_X, 0], [OUTSIDER, 'Test Outsider', CORP_X, 0],
    [CORPUSER, 'Test CorpUser', CORP_B, 0], [GRANTED, 'Test Granted', CORP_A, 0],
];
function cleanup() {
    global $db, $chars;
    foreach ([MASK_A, MASK_B] as $m) {
        foreach (['fork_mask_admins', 'fork_mask_blocks', 'fork_mask_defaults', 'fork_mask_audit', '`groups`', 'masks', 'statistics'] as $t) {
            try { $db->prepare("DELETE FROM $t WHERE maskID = ?")->execute([$m]); } catch (PDOException $e) { if ($e->getCode() !== '42S02') throw $e; }
        }
    }
    $ids = implode(',', array_map(function ($c) { return (int) $c[0]; }, $chars));
    $db->exec("DELETE FROM characters WHERE characterID IN ($ids)");
    $db->exec("DELETE FROM accounts WHERE username LIKE 'maskadmin-test-%'");
    foreach (glob('/var/lib/php/session/sess_maskadmintest*') ?: [] as $f) @unlink($f);
}
cleanup();
maskadmin_ensure_schema($db);
foreach ($chars as $i => $c) {
    $db->prepare('INSERT INTO accounts (username, password) VALUES (?, ?)')->execute(['maskadmin-test-' . $i, 'x']);
    $uid = (int) $db->lastInsertId();
    $db->prepare('INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName, admin) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$uid, $c[0], $c[1], $c[2], 'Corp ' . $c[2], $c[3]]);
}
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_A, 'Test mask A', OWNER]);
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 2)')->execute([MASK_B, 'Test mask B', CORP_B]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_A, CORP_A]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 1373)')->execute([MASK_A, DIRECT]);
$actor = function ($id, $name) { return ['id' => $id, 'name' => $name]; };
$O = $actor(OWNER, 'Test Owner'); $CA = $actor(CORPADMIN, 'Test CorpAdmin'); $M1 = $actor(MEMBER1, 'Test Member One'); $G = $actor(GRANTED, 'Test Granted');
$X = $actor(OUTSIDER, 'Test Outsider'); $CU = $actor(CORPUSER, 'Test CorpUser');

// ---- 1. library ----
check('level owner', maskadmin_level($db, MASK_A, OWNER), 'owner');
check('level corp admin', maskadmin_level($db, MASK_B, CORPADMIN), 'corp-admin');
check('level corp user (no admin flag)', maskadmin_level($db, MASK_B, CORPUSER), null);
check('level member', maskadmin_level($db, MASK_A, MEMBER1), null);
check('level corp admin has nothing on mask A', maskadmin_level($db, MASK_A, CORPADMIN), null);
check('level owner has nothing on mask B', maskadmin_level($db, MASK_B, OWNER), null);
check('level unknown character', maskadmin_level($db, MASK_A, 1), null);
check('corp mask: corp admin', maskadmin_level($db, CORP_B . '.2', CORPADMIN), 'corp-admin');
check('corp mask: other corp admin', maskadmin_level($db, CORP_A . '.2', CORPADMIN), null);
check('is_custom', [maskadmin_is_custom('12.0'), maskadmin_is_custom('0.0'), maskadmin_is_custom('12.2'), maskadmin_is_custom('12.0; DROP'), maskadmin_is_custom(null)], [true, false, false, false, false]);

// grant: who may
check('grant by non-admin member', maskadmin_grant($db, MASK_A, $M1, MEMBER2)[2], 403);
check('grant by outsider', maskadmin_grant($db, MASK_A, $X, MEMBER2)[2], 403);
check('grant by owner of another mask (cross-mask)', maskadmin_grant($db, MASK_B, $O, CORPUSER)[2], 403);
check('grant to the owner', maskadmin_grant($db, MASK_A, $CA, OWNER)[2], 403);   // CA is no manager of A at all
check('grant to the owner by the owner', maskadmin_grant($db, MASK_A, $O, OWNER)[2], 400);
check('grant to a corp admin by a corp admin', maskadmin_grant($db, MASK_B, $CA, CORPADMIN)[2], 400);
check('grant to a character without access', maskadmin_grant($db, MASK_A, $O, OUTSIDER)[2], 404);
check('grant to an unknown character', maskadmin_grant($db, MASK_A, $O, 12345)[2], 404);
check('grant on a non-custom mask', maskadmin_grant($db, CORP_A . '.2', $O, MEMBER1)[2], 400);
check('grant ok (corp access)', maskadmin_grant($db, MASK_A, $O, GRANTED)[0], true);
check('grant is idempotent', maskadmin_grant($db, MASK_A, $O, GRANTED)[0], true);
check('granted level', maskadmin_level($db, MASK_A, GRANTED), 'granted');
check('grant wrote one audit line', (int) $db->query("SELECT COUNT(*) FROM fork_mask_audit WHERE maskID = '" . MASK_A . "' AND action = 'grant'")->fetchColumn(), 1);
check('corp user of mask B can be granted by corp admin', maskadmin_grant($db, MASK_B, $CA, CORPUSER)[0], true);
check('granted admin may not grant', maskadmin_grant($db, MASK_A, $G, MEMBER2)[2], 403);
check('granted admin may not revoke', maskadmin_revoke($db, MASK_A, $G, GRANTED)[2], 403);
check('revoke the owner', maskadmin_revoke($db, MASK_A, $O, OWNER)[2], 400);
check('revoke a corp admin', maskadmin_revoke($db, MASK_B, $CA, CORPADMIN)[2], 400);
check('revoke someone not granted', maskadmin_revoke($db, MASK_A, $O, MEMBER2)[2], 404);
check('revoke by non-admin', maskadmin_revoke($db, MASK_A, $M1, GRANTED)[2], 403);
check('revoke mask B admin from mask A (cross-mask)', maskadmin_revoke($db, MASK_A, $O, CORPUSER)[2], 404);
check('mask B grant survived', maskadmin_level($db, MASK_B, CORPUSER), 'granted');

// block
check('block by non-admin', maskadmin_block($db, MASK_A, $M1, MEMBER2, 'x')[2], 403);
check('block by outsider', maskadmin_block($db, MASK_A, $X, MEMBER2, 'x')[2], 403);
check('block the owner (by granted admin)', maskadmin_block($db, MASK_A, $G, OWNER, 'x')[2], 400);
check('block a corp admin', maskadmin_block($db, MASK_B, $O, CORPADMIN, 'x')[2], 403);
check('block a corp admin by a corp admin', maskadmin_block($db, MASK_B, $CA, CORPADMIN, 'x')[2], 400);
check('block yourself', maskadmin_block($db, MASK_A, $G, GRANTED, 'x')[2], 400);
check('block a granted admin', maskadmin_block($db, MASK_A, $O, GRANTED, 'x')[2], 409);
check('block without a reason', maskadmin_block($db, MASK_A, $G, MEMBER2, "  \n ")[2], 400);
check('block a character without access', maskadmin_block($db, MASK_A, $G, OUTSIDER, 'x')[2], 404);
check('block from mask A a character of mask B only', maskadmin_block($db, MASK_A, $O, CORPUSER, 'x')[2], 404);
check('block on a non-custom mask', maskadmin_block($db, CORP_A . '.2', $O, MEMBER2, 'x')[2], 400);
check('block ok by granted admin', maskadmin_block($db, MASK_A, $G, MEMBER2, "Spied\ton us <b>x</b>")[0], true);
check('blocked', maskadmin_is_blocked($db, MASK_A, MEMBER2), true);
check('not blocked on mask B', maskadmin_is_blocked($db, MASK_B, MEMBER2), false);
check('reason stored cleaned', $db->query("SELECT reason FROM fork_mask_blocks WHERE characterID = " . MEMBER2)->fetchColumn(), 'Spied on us <b>x</b>');
check('reason cut at 200', (function () use ($db, $G) {
    maskadmin_block($db, MASK_A, $G, DIRECT, str_repeat('é', 300));
    return mb_strlen($db->query("SELECT reason FROM fork_mask_blocks WHERE characterID = " . DIRECT)->fetchColumn(), 'UTF-8');
})(), 200);
check('blocked session mask is dropped to the corp mask', maskadmin_enforced_mask($db, MASK_A, MEMBER2, CORP_A), CORP_A . '.2');
check('unblocked member keeps the mask', maskadmin_enforced_mask($db, MASK_A, MEMBER1, CORP_A), MASK_A);
check('blocked on A, mask B untouched', maskadmin_enforced_mask($db, MASK_B, MEMBER2, CORP_A), MASK_B);
check('corp mask never blocked', maskadmin_enforced_mask($db, CORP_A . '.2', MEMBER2, CORP_A), CORP_A . '.2');
check('block: unblock by non-admin', maskadmin_unblock($db, MASK_A, $M1, MEMBER2)[2], 403);
check('unblock someone not blocked', maskadmin_unblock($db, MASK_A, $G, MEMBER1)[2], 404);
check('unblock mask A block via mask B actor (cross-mask)', maskadmin_unblock($db, MASK_B, $CA, MEMBER2)[2], 404);
check('still blocked', maskadmin_is_blocked($db, MASK_A, MEMBER2), true);
check('a blocked granted admin has no level (safety net)', (function () use ($db) {
    $db->prepare("INSERT INTO fork_mask_blocks (maskID, characterID, characterName, reason, blockedBy, blockedByName, blockedAt) VALUES (?, ?, 'x', 'x', 1, 'x', NOW())")->execute([MASK_A, GRANTED]);
    $level = maskadmin_level($db, MASK_A, GRANTED);
    $db->prepare('DELETE FROM fork_mask_blocks WHERE maskID = ? AND characterID = ?')->execute([MASK_A, GRANTED]);
    return $level;
})(), null);
check('grant to a blocked character', maskadmin_grant($db, MASK_A, $O, MEMBER2)[2], 409);
check('unblock ok', maskadmin_unblock($db, MASK_A, $G, MEMBER2)[0], true);
check('unblocked', maskadmin_is_blocked($db, MASK_A, MEMBER2), false);

// remove
check('remove by non-admin', maskadmin_remove($db, MASK_A, $M1, DIRECT)[2], 403);
check('remove corp-access member', maskadmin_remove($db, MASK_A, $G, MEMBER1)[2], 409);
check('remove the owner', maskadmin_remove($db, MASK_A, $G, OWNER)[2], 400);
check('remove a granted admin', maskadmin_remove($db, MASK_A, $O, GRANTED)[2], 409);
maskadmin_unblock($db, MASK_A, $G, DIRECT);
check('remove direct entry', maskadmin_remove($db, MASK_A, $G, DIRECT)[0], true);
check('direct entry gone', maskadmin_direct_entry($db, MASK_A, DIRECT), false);

// defaults
check('defaults by non-admin', maskadmin_defaults_save($db, MASK_A, $M1, ['sizeTags' => ['enabled' => false]])[2], 403);
check('defaults on other mask by its non-admin', maskadmin_defaults_save($db, MASK_B, $O, ['a' => 1])[2], 403);
check('defaults on a mask that is not mask-like', maskadmin_defaults_save($db, 'abc', $O, ['a' => 1])[2], 400);
check('defaults denied key', maskadmin_defaults_save($db, MASK_A, $O, ['masks' => ['active' => '5.0']])[2], 400);
check('defaults bad key', maskadmin_defaults_save($db, MASK_A, $O, ['__proto__' => 1])[2], 400);
check('defaults html in a string', maskadmin_defaults_save($db, MASK_A, $O, ['a' => '<img src=x>'])[2], 400);
check('defaults list instead of object', maskadmin_defaults_save($db, MASK_A, $O, [1, 2])[2], 400);
check('defaults too deep', maskadmin_defaults_save($db, MASK_A, $O, ['a' => [[[[[[1]]]]]]])[2], 400);
check('defaults too large', maskadmin_defaults_save($db, MASK_A, $O, ['a' => array_fill(0, 50, str_repeat('x', 200)), 'b' => array_fill(0, 50, str_repeat('y', 200))])[2], 400);
check('defaults ok by granted admin', maskadmin_defaults_save($db, MASK_A, $G, ['sizeTags' => ['enabled' => false], 'soundMute' => ['enabled' => true, 'volume' => 0.5]])[0], true);
check('defaults load', json_decode(json_encode(maskadmin_defaults_load($db, MASK_A)['defaults']), true), ['sizeTags' => ['enabled' => false], 'soundMute' => ['enabled' => true, 'volume' => 0.5]]);
check('defaults of mask B are separate', (array) maskadmin_defaults_load($db, MASK_B)['defaults'], []);
check('defaults on the corp mask by its admin', maskadmin_defaults_save($db, CORP_B . '.2', $CA, ['a' => 1])[0], true);
$db->prepare('DELETE FROM fork_mask_defaults WHERE maskID = ?')->execute([CORP_B . '.2']);
check('defaults cleared', maskadmin_defaults_save($db, MASK_A, $O, [])[0], true);
check('defaults gone', (array) maskadmin_defaults_load($db, MASK_A)['defaults'], []);

// the hook upstream's checkAdmin() has
$_SESSION = ['characterID' => GRANTED, 'corporationID' => CORP_A, 'admin' => 0, 'userID' => 1, 'mask' => MASK_A];
require_once(__DIR__ . '/../lib.inc.php');
check('checkAdmin: granted admin', checkAdmin(MASK_A), true);
check('checkAdmin: granted admin on another mask', checkAdmin(MASK_B), false);
check('checkAdmin: corp-admin-only check is false for granted', maskadmin_corp_admin(MASK_A), false);
$_SESSION['characterID'] = MEMBER1;
check('checkAdmin: plain member', checkAdmin(MASK_A), false);
$_SESSION['characterID'] = CORPADMIN; $_SESSION['corporationID'] = CORP_B; $_SESSION['admin'] = 1;
check('checkAdmin: corp admin still works (upstream)', checkAdmin(MASK_B), true);
check('maskadmin_corp_admin: corp admin', maskadmin_corp_admin(MASK_B), true);
$_SESSION = ['mask' => MASK_A, 'characterID' => MEMBER2, 'corporationID' => CORP_A];
maskadmin_enforce_session($db);
check('enforce_session: not blocked, unchanged', $_SESSION['mask'], MASK_A);
maskadmin_block($db, MASK_A, $O, MEMBER2, 'test');
maskadmin_enforce_session($db);
check('enforce_session: blocked, dropped', $_SESSION['mask'], CORP_A . '.2');
maskadmin_unblock($db, MASK_A, $O, MEMBER2);
$_SESSION = [];

// ---- 2. HTTP ----
function make_session($name, array $data) {
    $sid = 'maskadmintest' . $name;
    $path = '/var/lib/php/session/sess_' . $sid;
    $payload = '';
    foreach ($data as $k => $v) {
        $payload .= $k . '|' . serialize($v);
    }
    file_put_contents($path, $payload);
    @chown($path, 'www-data');
    @chmod($path, 0600);
    return $sid;
}
function http($method, $path, $sid, $body = null, array $headers = []) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    if ($sid) $headers[] = 'Cookie: PHPSESSID=' . $sid;
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, json_decode((string) $text, true), $text];
}
function sess($name, $id, $charName, $corp, $mask, $admin = 0) {
    return make_session($name, ['userID' => $id, 'mask' => $mask, 'characterID' => $id, 'characterName' => $charName, 'corporationID' => $corp, 'allianceID' => null, 'admin' => $admin, 'super' => 0]);
}
function post($sid, $csrf, array $data, array $extra = []) {
    $headers = array_merge(['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf], $extra);
    return http('POST', 'mask_admins.php', $sid, json_encode($data), $headers);
}
$sOwner = sess('owner', OWNER, 'Test Owner', CORP_OWNER, MASK_A);
$sMember = sess('member', MEMBER1, 'Test Member One', CORP_A, MASK_A);
$sGranted = sess('granted', GRANTED, 'Test Granted', CORP_A, MASK_A);
$sBlocked = sess('blocked', MEMBER2, 'Test Member Two', CORP_A, MASK_A);
$sCorpUser = sess('corpuser', CORPUSER, 'Test CorpUser', CORP_B, MASK_B);
$sCorpAdmin = sess('corpadmin', CORPADMIN, 'Test CorpAdmin', CORP_B, MASK_B, 1);

check('http: no session', http('GET', 'mask_admins.php?mode=get', null)[0], 403);
list($st, $out) = http('GET', 'mask_admins.php?mode=get', $sOwner);
check('http: owner gets the state', [$st, $out['canAdmin'], $out['canManage'], isset($out['csrf'])], [200, true, true, true]);
$csrfOwner = $out['csrf'];
check('http: owner listed', $out['owners'][0]['kind'], 'owner');
check('http: members listed (corp A + owner + statistics), outsider not', in_array('Test Outsider', array_column($out['members'], 'characterName'), true), false);
check('http: member listed', in_array('Test Member One', array_column($out['members'], 'characterName'), true), true);
list($st, $out) = http('GET', 'mask_admins.php?mode=get', $sMember);
check('http: member gets no admin data and no csrf', [$st, $out['canAdmin'], isset($out['csrf']), isset($out['members'])], [200, false, false, false]);
check('http: member can read the defaults', http('GET', 'mask_admins.php?mode=defaults', $sMember)[0], 200);

list($st, $out) = http('GET', 'mask_admins.php?mode=get', $sGranted);
check('http: granted admin (granted earlier in this test) can admin but not manage', [$out['canAdmin'], $out['canManage']], [true, false]);
$csrfGranted = $out['csrf'];

// CSRF and request hygiene (owner)
check('csrf: missing token', post($sOwner, '', ['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'x'])[0], 403);
check('csrf: wrong token', post($sOwner, str_repeat('a', 64), ['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'x'])[0], 403);
check('csrf: another session\'s token', post($sOwner, $csrfGranted, ['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'x'])[0], 403);
check('csrf: form post instead of JSON', http('POST', 'mask_admins.php', $sOwner, 'mode=block&characterID=' . MEMBER2 . '&reason=x', ['X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrfOwner])[0], 415);
check('csrf: no X-Requested-With', http('POST', 'mask_admins.php', $sOwner, json_encode(['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'x']), ['Content-Type: application/json', 'X-CSRF-Token: ' . $csrfOwner])[0], 400);
check('csrf: cross-origin', post($sOwner, $csrfOwner, ['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'x'], ['Origin: https://evil.example', 'Host: localhost'])[0], 403);
check('csrf: query string POST (no body)', http('POST', 'mask_admins.php?mode=block&characterID=' . MEMBER2, $sOwner, '', ['X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrfOwner])[0], 415);
check('nothing was blocked by the refused requests', maskadmin_is_blocked($db, MASK_A, MEMBER2), false);
check('http: member POST (no token issued)', post($sMember, '', ['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'x'])[0], 403);
check('http: unknown mode', post($sOwner, $csrfOwner, ['mode' => 'drop'])[0], 400);
check('http: bad characterID', post($sOwner, $csrfOwner, ['mode' => 'block', 'characterID' => '1; DROP', 'reason' => 'x'])[0], 400);
check('http: method not allowed', http('DELETE', 'mask_admins.php', $sOwner)[0], 405);

// admin work over HTTP
list($st, $out) = post($sOwner, $csrfOwner, ['mode' => 'grant', 'characterID' => (string) MEMBER1]);
check('http: owner grants', [$st, $out['result'] ?? null], [200, true]);
check('http: granted listed', in_array(MEMBER1, array_map('intval', array_column($out['granted'], 'characterID')), true), true);
check('http: granted admin cannot grant', post($sGranted, $csrfGranted, ['mode' => 'grant', 'characterID' => MEMBER2])[0], 403);
check('http: granted admin cannot revoke the owner', post($sGranted, $csrfGranted, ['mode' => 'revoke', 'characterID' => OWNER])[0], 403);
check('http: nobody revokes the owner', post($sOwner, $csrfOwner, ['mode' => 'revoke', 'characterID' => OWNER])[0], 400);
check('http: grant to a character of another mask only', post($sOwner, $csrfOwner, ['mode' => 'grant', 'characterID' => CORPUSER])[0], 404);
// a "mask" in the body is ignored: the owner of A cannot touch B
list($st, $out) = post($sOwner, $csrfOwner, ['mode' => 'block', 'characterID' => MEMBER2, 'reason' => 'spy', 'mask' => MASK_B, 'maskID' => MASK_B]);
check('http: block on the session mask', [$st, $out['result'] ?? null], [200, true]);
check('http: block landed on mask A only', [maskadmin_is_blocked($db, MASK_A, MEMBER2), maskadmin_is_blocked($db, MASK_B, MEMBER2)], [true, false]);
check('http: owner of A cannot block a corp user of B', post($sOwner, $csrfOwner, ['mode' => 'block', 'characterID' => CORPUSER, 'reason' => 'x', 'mask' => MASK_B])[0], 404);
list($st, $out) = http('GET', 'mask_admins.php?mode=get&mask=' . MASK_B, $sCorpUser);
check('http: ?mask= of A is ignored (the admin of B stays on B)', [$st, $out['mask']['id']], [200, MASK_B]);
list($st, $out) = http('GET', 'mask_admins.php?mode=get', $sCorpAdmin);
check('http: corp admin manages B', [$out['canAdmin'], $out['canManage'], $out['mask']['id']], [true, true, MASK_B]);
$csrfCA = $out['csrf'];
check('http: corp admin cannot block the owner of A (not his mask)', post($sCorpAdmin, $csrfCA, ['mode' => 'block', 'characterID' => OWNER, 'reason' => 'x', 'mask' => MASK_A])[0], 404);
check('http: corp admin cannot revoke on A', post($sCorpAdmin, $csrfCA, ['mode' => 'revoke', 'characterID' => GRANTED, 'mask' => MASK_A])[0], 404);
check('http: granted on A unaffected', maskadmin_level($db, MASK_A, GRANTED), 'granted');

// defaults over HTTP
check('http: defaults by a member', post($sMember, '', ['mode' => 'defaults-save', 'defaults' => ['a' => 1]])[0], 403);
list($st, $out) = post($sOwner, $csrfOwner, ['mode' => 'defaults-save', 'defaults' => ['sizeTags' => ['enabled' => false]]]);
check('http: owner saves defaults', [$st, $out['defaults']['sizeTags']['enabled'] ?? null], [200, false]);
check('http: bad defaults', post($sOwner, $csrfOwner, ['mode' => 'defaults-save', 'defaults' => ['masks' => 1]])[0], 400);
list($st, $out) = http('GET', 'mask_admins.php?mode=defaults', $sMember);
check('http: member reads the mask defaults', $out['defaults']['sizeTags']['enabled'] ?? null, false);

// the blocked character's next request: the session mask is dropped before the endpoint runs
list($st, $out) = http('GET', 'mask_admins.php?mode=defaults', $sBlocked);
check('http: blocked character is on the corp mask', $out['mask'], CORP_A . '.2');
check('http: blocked character sees no defaults of the blocked mask', (array) $out['defaults'], []);
list($st, $out) = http('GET', 'masks.php', $sBlocked);
check('http: blocked mask hidden from the mask list', in_array(MASK_A, array_column($out['masks'] ?? [], 'mask'), false), false);
list($st, $out) = http('GET', 'masks.php', $sMember);
check('http: others still see it', in_array(MASK_A, array_map('strval', array_column($out['masks'] ?? [], 'mask')), true), true);
list($st, $out) = http('GET', 'admin.php?mode=access-list', $sBlocked);
check('http: blocked character is no admin of the mask any more (admin.php)', $out['results'] ?? null, null);
// unblock over HTTP
post($sOwner, $csrfOwner, ['mode' => 'unblock', 'characterID' => MEMBER2]);
list($st, $out) = http('GET', 'mask_admins.php?mode=defaults', $sBlocked);
check('http: after unblock the character stays on the corp mask until they pick the mask again', $out['mask'], CORP_A . '.2');
check('http: the granted member can use upstream mask admin (admin.php access-list)', isset(http('GET', 'admin.php?mode=access-list', $sGranted)[1]['results']), true);
post($sOwner, $csrfOwner, ['mode' => 'revoke', 'characterID' => MEMBER1]);
check('http: a plain member can not (admin.php access-list)', isset(http('GET', 'admin.php?mode=access-list', $sMember)[1]['results']), false);
check('http: granted admin cannot delete the mask (masks.php)', http('POST', 'masks.php', $sGranted, http_build_query(['mode' => 'delete', 'mask' => MASK_A]))[1]['result'] ?? null, null);
check('http: mask A still exists', (int) $db->query("SELECT COUNT(*) FROM masks WHERE maskID = '" . MASK_A . "'")->fetchColumn(), 1);

// audit trail
list($st, $out) = http('GET', 'mask_admins.php?mode=get', $sOwner);
$actions = array_column($out['audit'], 'action');
check('audit: grant, block, defaults are listed', [in_array('grant', $actions, true), in_array('block', $actions, true), in_array('defaults', $actions, true), in_array('unblock', $actions, true)], [true, true, true, true]);

cleanup();
echo "$count checks, $failures failed\n";
exit($failures ? 1 : 0);
