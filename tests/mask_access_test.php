<?php
// Fork-owned: mask access end to end against the dev stack (its MySQL and nginx/PHP in the app container, the dev
// login from docker/dev-seed.sh).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/mask_access_test.php
// A character without access to a custom mask sets masks.active to non-canonical spellings of that mask (and of
// other characters' / corporations' masks) through options.php, then reads (refresh.php) and writes (comments.php):
// it must only ever see and write its own corporation mask. A member of the custom mask still gets it (also from a
// non-canonical spelling, which is canonicalised), and the dev character's own corporation / personal masks still work.
// Also checks the REST API (public/api.php) mask check. Everything it creates is deleted at the end and the dev
// user's preferences are put back.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

$base = getenv('MASK_TEST_BASE') ?: 'http://127.0.0.1';
$user = getenv('DEV_USERNAME') ?: 'dev';
$password = getenv('DEV_PASSWORD') ?: 'dev-password';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

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

/** One HTTP request with a cookie jar: [status, decoded JSON body, raw body] */
function http($method, $path, $jar, $body = null, array $headers = [], $auth = null) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
        CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    if ($auth !== null) curl_setopt($ch, CURLOPT_USERPWD, $auth);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, json_decode((string) $text, true), (string) $text];
}
function login($jar) {
    global $user, $password;
    @unlink($jar);
    [, $out] = http('POST', 'login.php', $jar, http_build_query(['mode' => 'login', 'username' => $user, 'password' => $password]));
    if (($out['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }
    return $out['session'];
}
/** Sets masks.active through options.php; returns the mask options.php stored. */
function set_mask($jar, $active) {
    [$status, $out] = http('POST', 'options.php', $jar, http_build_query(['mode' => 'set', 'options' => json_encode(['masks' => ['active' => $active]])]));
    return [$status, $out['options']['masks']['active'] ?? null];
}
/** refresh.php init for $system: [signature ids, comment texts] seen */
function read_mask($jar, $system) {
    [$status, $out] = http('POST', 'refresh.php', $jar, http_build_query(['mode' => 'init', 'systemID' => $system, 'instance' => 1]));
    $sigs = array_map(function ($s) { return (int) $s['id']; }, array_values($out['signatures'] ?? []));
    $comments = array_map(function ($c) { return $c['comment']; }, $out['comments'] ?? []);
    return [$status, $sigs, $comments];
}
function write_comment($jar, $system, $text) {
    return http('POST', 'comments.php', $jar, http_build_query(['mode' => 'save', 'systemID' => $system, 'comment' => $text]));
}

$jar = sys_get_temp_dir() . '/mask-access.cookies';
$stmt = $db->prepare('SELECT a.id, c.characterID, c.corporationID FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute([$user]);
$me = $stmt->fetch(PDO::FETCH_ASSOC);
if (!$me) { fwrite(STDERR, "no dev user (run docker/dev-seed.sh first)\n"); exit(1); }
$stmt = $db->prepare('SELECT options FROM preferences WHERE userID = ?');
$stmt->execute([$me['id']]);
$savedOptions = $stmt->fetchColumn();

// Fixtures: another corporation's custom mask, another character's personal mask, another corporation's mask, each
// with a signature and a note in a test system.
$system = 31000005;
$victimCustom = '991001.0';
$victimPersonal = '991002.1';
$victimCorp = '991003.2';
$marker = 'mask-access-test';
$cleanup = function () use ($db, $me, $savedOptions, $marker, $victimCustom) {
    $db->prepare('DELETE FROM signatures WHERE name = ?')->execute([$marker]);
    $db->prepare('DELETE FROM comments WHERE comment LIKE ?')->execute(["%$marker%"]);
    $db->prepare('DELETE FROM `groups` WHERE maskID = ?')->execute([$victimCustom]);
    $db->prepare('DELETE FROM masks WHERE maskID = ?')->execute([$victimCustom]);
    if ($savedOptions === false) $db->prepare('DELETE FROM preferences WHERE userID = ?')->execute([$me['id']]);
    else $db->prepare('UPDATE preferences SET options = ? WHERE userID = ?')->execute([$savedOptions, $me['id']]);
};
register_shutdown_function($cleanup);
$cleanup();
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, 991003, 2)')->execute([$victimCustom, $marker]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, 991003, 2)')->execute([$victimCustom]);
$sigIDs = [];
$sigStmt = $db->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID) VALUES ('ABC123', ?, 'combat', ?, 72, 1, 'test', 1, 'test', ?)");
$commentStmt = $db->prepare("INSERT INTO comments (systemID, comment, created, createdByID, createdByName, modifiedByID, modifiedByName, maskID) VALUES (?, ?, NOW(), 1, 'test', 1, 'test', ?)");
foreach ([$victimCustom, $victimPersonal, $victimCorp] as $mask) {
    $sigStmt->execute([$system, $marker, $mask]);
    $sigIDs[$mask] = (int) $db->lastInsertId();
    $commentStmt->execute([$system, "$marker secret of $mask", $mask]);
}
$ownCorp = $me['corporationID'] . '.2';
$ownChar = $me['characterID'] . '.1';
$sigStmt->execute([$system, $marker, $ownCorp]);
$sigIDs[$ownCorp] = (int) $db->lastInsertId();
$sigStmt->execute([$system, $marker, $ownChar]);
$sigIDs[$ownChar] = (int) $db->lastInsertId();

/** Comments the dev character wrote into $mask during this test */
$writtenTo = function ($mask) use ($db, $me, $marker) {
    $stmt = $db->prepare('SELECT COUNT(*) FROM comments WHERE createdByID = ? AND maskID = ? AND comment LIKE ?');
    $stmt->execute([$me['characterID'], $mask, "%$marker write%"]);
    return (int) $stmt->fetchColumn();
};

$session = login($jar);
check('login: default mask is the corporation mask', $session['mask'], $ownCorp);
$ownMasks = [$ownCorp, $ownChar];
if (!empty($session['allianceID'])) $ownMasks[] = $session['allianceID'] . '.3';

// 1. No access: every spelling of someone else's mask ends up on the own corporation mask.
$bad = [
    '991001.0abc', '991001.00', '0991001.0', '00991001.0', ' 991001.0', '991001.0 ', "991001.0\n", '991001.0.0', '991001.0e0',
    '9910010e-1', '+991001.0', '991001.', '.0', '991001', 'abc', '',
    '991002.1x', '0991002.1', '991002.10', '991003.2x', '0991003.2', '991003.20', '991003.3', '991003.3x',
    '991001.0' . str_repeat('0', 40),
];
foreach ($bad as $spelling) {
    $label = json_encode($spelling);
    [$status, $stored] = set_mask($jar, $spelling);
    check("$label: options.php status", $status, 200);
    check("$label: options.php stores one of the own masks", in_array($stored, $ownMasks, true), true);
    [$status, $sigs, $comments] = read_mask($jar, $system);
    check("$label: refresh.php status", $status, 200);
    foreach ([$victimCustom, $victimPersonal, $victimCorp] as $victim) {
        check("$label: no signature of $victim", in_array($sigIDs[$victim], $sigs, true), false);
        check("$label: no note of $victim", in_array("$marker secret of $victim", $comments, true), false);
    }
    if ($stored === $ownCorp) check("$label: sees the own corporation mask", in_array($sigIDs[$ownCorp], $sigs, true), true);
    $before = array_map($writtenTo, [$victimCustom, $victimPersonal, $victimCorp]);
    write_comment($jar, $system, "$marker write " . bin2hex($spelling));
    foreach ([$victimCustom, $victimPersonal, $victimCorp] as $i => $victim) {
        check("$label: nothing written to $victim", $writtenTo($victim) - $before[$i], 0);
    }
}
// Non-string values (JSON numbers, arrays, objects, null) never select another mask either.
foreach ([991001.0, 991001, ['991001.0'], ['a' => '991001.0'], true, null] as $value) {
    $label = json_encode($value);
    [$status, $stored] = set_mask($jar, $value);
    check("$label: options.php does not store another mask", in_array($stored, [$victimCustom, $victimPersonal, $victimCorp, 991001.0, 991001, '991001'], true), false);
    [, $sigs] = read_mask($jar, $system);
    check("$label: no signature of $victimCustom", in_array($sigIDs[$victimCustom], $sigs, true), false);
}

// 2. A session that already holds a bad mask (e.g. stored before the fix, or in the preferences at login) is reset.
$db->prepare('DELETE FROM comments WHERE createdByID = ? AND comment LIKE ?')->execute([$me['characterID'], "%$marker write%"]);
$db->prepare('UPDATE preferences SET options = ? WHERE userID = ?')->execute([json_encode(['masks' => ['active' => '991001.0abc']]), $me['id']]);
$session = login($jar);
check('login with a bad stored mask: session gets the corporation mask', $session['mask'], $ownCorp);
[, $sigs] = read_mask($jar, $system);
check('login with a bad stored mask: no custom mask signature', in_array($sigIDs[$victimCustom], $sigs, true), false);
write_comment($jar, $system, "$marker write after-login");
check('login with a bad stored mask: nothing written to the custom mask', $writtenTo($victimCustom), 0);

// 3. Own masks still work.
[, $stored] = set_mask($jar, $ownChar);
check('personal mask: stored', $stored, $ownChar);
[, $sigs] = read_mask($jar, $system);
check('personal mask: sees its signature', in_array($sigIDs[$ownChar], $sigs, true), true);
check('personal mask: not the corporation signature', in_array($sigIDs[$ownCorp], $sigs, true), false);
[, $stored] = set_mask($jar, $ownCorp);
check('corporation mask: stored', $stored, $ownCorp);
[, $sigs] = read_mask($jar, $system);
check('corporation mask: sees its signature', in_array($sigIDs[$ownCorp], $sigs, true), true);
if (!empty($session['allianceID'])) {
    [, $stored] = set_mask($jar, $session['allianceID'] . '.3');
    check('alliance mask: stored', $stored, $session['allianceID'] . '.3');
} else {
    [, $stored] = set_mask($jar, '991004.3');
    check('alliance mask without an alliance: corporation mask', $stored, $ownCorp);
}

// 4. A member of the custom mask gets it, also from a non-canonical spelling (canonicalised).
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 1373)')->execute([$victimCustom, $me['characterID']]);
foreach (['991001.0', '0991001.0'] as $spelling) {
    [, $stored] = set_mask($jar, $spelling);
    check("member $spelling: stored canonical", $stored, $victimCustom);
    [, $sigs, $comments] = read_mask($jar, $system);
    check("member $spelling: sees the custom mask signature", in_array($sigIDs[$victimCustom], $sigs, true), true);
    check("member $spelling: sees the custom mask note", in_array("$marker secret of $victimCustom", $comments, true), true);
}
$before = $writtenTo($victimCustom);
write_comment($jar, $system, "$marker write member");
check('member: note written to the custom mask', $writtenTo($victimCustom) - $before, 1);
// Access removed while the mask is active: the next request falls back to the corporation mask.
$db->prepare('DELETE FROM `groups` WHERE maskID = ? AND eveID = ? AND eveType = 1373')->execute([$victimCustom, $me['characterID']]);
$before = $writtenTo($victimCustom);
write_comment($jar, $system, "$marker write revoked");
check('access revoked: next write is not in the custom mask', $writtenTo($victimCustom) - $before, 0);
[, $sigs] = read_mask($jar, $system);
check('access revoked: no custom mask signature', in_array($sigIDs[$victimCustom], $sigs, true), false);

// 5. REST API (public/api.php, basic auth): another mask's data is refused, own corporation mask works.
$auth = "$user:$password";
foreach (['991001.0', '991001.00', '991001.0abc', '991002.1', '991003.2', '991003.2x'] as $spelling) {
    [$status, , $raw] = http('GET', 'api.php?q=/signatures&maskID=' . rawurlencode($spelling), $jar, null, [], $auth);
    check("api $spelling: refused", strpos($raw, $marker) === false && strpos($raw, 'not authorized') !== false, true);
}
[$status, $out] = http('GET', 'api.php?q=/signatures&maskID=' . rawurlencode($ownCorp), $jar, null, [], $auth);
check('api own corporation mask: status', $status, 200);
check('api own corporation mask: returns its signature', in_array($sigIDs[$ownCorp], array_map('intval', array_column(is_array($out) ? $out : [], 'id')), true), true);

echo ($failures ? "FAILED $failures of $count checks\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
