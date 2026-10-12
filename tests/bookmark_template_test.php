<?php
// Fork-owned: mask-wide bookmark naming templates against the dev stack (needs its MySQL, nginx/PHP in the app container and
// the dev login from docker/dev-seed.sh).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/bookmark_template_test.php
// 1. bookmark/bookmark.inc.php: the validation rules (the same cases as app/js-test/fork/bookmark-template.test.js).
// 2. public/bookmark_template.php over HTTP: every member reads the mask's templates (defaults first), only the owner / the
//    owning corporation's Tripwire admins save and reset, CSRF / X-Requested-With / Origin / JSON checks, validation errors,
//    a "mask" in the body being ignored, and the change showing in Mask Admin's audit trail.
// Logs in as the dev user (DEV_USERNAME / DEV_PASSWORD) and flips its characters.admin flag for the non-admin checks. What it
// changes on the dev corp mask (admin flag, templates, audit rows) is put back when it ends.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
require_once(__DIR__ . '/../bookmark/bookmark.inc.php');

$base = getenv('BOOKMARK_BASE') ?: 'http://127.0.0.1';
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

// ---- 1. validation ----
$valid = [
    ['hole', '={name} {class} {sig} {life}'], ['hole', '{name}-{sigid} {type}'], ['hole', '{NAME} {Size} {system}'],
    ['back', '!{name}'], ['back', '<{name} {dir}'], ['back', '! {name} {system}'],
];
foreach ($valid as $c) check('valid ' . $c[0] . ' ' . $c[1], bookmark_validate($c[0], $c[1]), '');
$invalid = [
    ['hole', '', 'empty'], ['hole', '   ', 'empty'], ['hole', '={class} {sig}', '{name}'], ['hole', '={name} {nope}', 'Unknown token'],
    ['hole', '={name', 'Unbalanced'], ['hole', '={name}}', 'Unbalanced'], ['hole', '={name} "x"', 'allowed'], ["hole", "={name}\n{sig}", 'allowed'],
    ['hole', '={name}&{sig}', 'allowed'], ['back', '={name}', 'start with'], ['back', '{name}', 'start with'],
    ['hole', '{name} {system} {system} {system} {system}', 'Too long'], ['hole', str_repeat('x', 81) . '{name}', 'at most 80'], ['other', '{name}', 'Unknown template'],
];
foreach ($invalid as $c) {
    $error = bookmark_validate($c[0], $c[1]);
    check('invalid ' . $c[0] . ' ' . substr(json_encode($c[1]), 0, 30), $error !== '' && stripos($error, $c[2]) !== false, true);
}
check('not a string', bookmark_validate('hole', null) !== '', true);
check('defaults are valid', [bookmark_validate('hole', bookmark_defaults()['hole']), bookmark_validate('back', bookmark_defaults()['back'])], ['', '']);
check('expand', bookmark_expand('={name}  {class} {sig}', ['name' => 'A', 'sig' => 'XYZ']), '=A XYZ');
check('expand drops unsafe characters', bookmark_expand('{name}', ['name' => 'A<b>"&']), 'Ab');
list($clean, $errors) = bookmark_validate_input(['hole' => ' ={name} ', 'back' => '!{name}']);
check('input trimmed', $clean, ['hole' => '={name}', 'back' => '!{name}']);
list($clean, $errors) = bookmark_validate_input(['hole' => '={name}', 'back' => '{name}']);
check('input error per template', [$clean, array_keys($errors)], [null, ['back']]);

// ---- 2. endpoint ----
function http($method, $path, $jar, $body = null, array $headers = []) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
        CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, json_decode((string) $text, true)];
}
function post($jar, $csrf, array $data, array $extra = []) {
    $headers = array_merge(['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf], $extra);
    return http('POST', 'bookmark_template.php', $jar, json_encode($data), $headers);
}

$jar = sys_get_temp_dir() . '/bookmark-admin.cookies';
@unlink($jar);
[$status, $out] = http('POST', 'login.php', $jar, http_build_query(['mode' => 'login', 'username' => $user, 'password' => $password]));
if (($out['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }

$stmt = $db->prepare('SELECT c.characterID, c.corporationID, c.admin FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute([$user]);
$me = $stmt->fetch(PDO::FETCH_ASSOC);
$mask = $me['corporationID'] . '.2';
$savedAdmin = (int) $me['admin'];
bookmark_ensure_schema($db);
$stmt = $db->prepare('SELECT * FROM fork_bookmark_templates WHERE maskID = ?');
$stmt->execute([$mask]);
$savedRow = $stmt->fetch(PDO::FETCH_ASSOC);
register_shutdown_function(function () use ($db, $me, $mask, $savedAdmin, $savedRow) {
    $db->prepare('UPDATE characters SET admin = ? WHERE characterID = ?')->execute([$savedAdmin, $me['characterID']]);
    $db->prepare('DELETE FROM fork_bookmark_templates WHERE maskID = ?')->execute([$mask]);
    if ($savedRow) {
        $db->prepare('INSERT INTO fork_bookmark_templates (maskID, `data`, updatedBy, updatedAt) VALUES (?, ?, ?, ?)')
            ->execute([$savedRow['maskID'], $savedRow['data'], $savedRow['updatedBy'], $savedRow['updatedAt']]);
    }
    try { $db->prepare("DELETE FROM fork_mask_audit WHERE maskID = ? AND action = 'bookmarks'")->execute([$mask]); } catch (PDOException $e) { /* no audit table */ }
});
$db->prepare('DELETE FROM fork_bookmark_templates WHERE maskID = ?')->execute([$mask]);

// A non-admin member reads the defaults and cannot change anything
$db->prepare('UPDATE characters SET admin = 0 WHERE characterID = ?')->execute([$me['characterID']]);
[$status, $out] = http('GET', 'bookmark_template.php?mode=get', $jar);
check('member GET status', $status, 200);
check('member reads the defaults', $out['templates'], bookmark_defaults());
check('member cannot edit', [$out['canEdit'], isset($out['csrf'])], [false, false]);
[$status, $out] = post($jar, 'x', ['mode' => 'save', 'hole' => '={name}', 'back' => '!{name}']);
check('member POST refused', $status, 403);

// A Tripwire admin of the corporation
$db->prepare('UPDATE characters SET admin = 1 WHERE characterID = ?')->execute([$me['characterID']]);
[$status, $out] = http('GET', 'bookmark_template.php?mode=get', $jar);
check('admin can edit', [$status, $out['canEdit'], strlen($out['csrf'] ?? '') > 20], [200, true, true]);
$csrf = $out['csrf'];
check('mask is the session\'s', $out['mask'], $mask);

[$status, $out] = post($jar, '', ['mode' => 'save', 'hole' => '={name}', 'back' => '!{name}']);
check('no CSRF token', $status, 403);
[$status, $out] = post($jar, 'wrong', ['mode' => 'save', 'hole' => '={name}', 'back' => '!{name}']);
check('wrong CSRF token', $status, 403);
[$status, $out] = http('POST', 'bookmark_template.php', $jar, json_encode(['mode' => 'save', 'hole' => '={name}', 'back' => '!{name}']), ['Content-Type: application/json', 'X-CSRF-Token: ' . $csrf]);
check('no X-Requested-With', $status, 400);
[$status, $out] = http('POST', 'bookmark_template.php', $jar, 'mode=save', ['Content-Type: application/x-www-form-urlencoded', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf]);
check('not JSON', $status, 415);
[$status, $out] = post($jar, $csrf, ['mode' => 'save', 'hole' => '={name}', 'back' => '!{name}'], ['Origin: http://evil.example']);
check('cross-origin', $status, 403);
[$status, $out] = post($jar, $csrf, ['mode' => 'nope']);
check('unknown mode', $status, 400);

[$status, $out] = post($jar, $csrf, ['mode' => 'save', 'hole' => '={class}', 'back' => '!{name}']);
check('invalid hole template', [$status, array_keys($out['errors'] ?? [])], [400, ['hole']]);
[$status, $out] = post($jar, $csrf, ['mode' => 'save', 'hole' => '={name}', 'back' => '{name}']);
check('invalid return template', [$status, array_keys($out['errors'] ?? [])], [400, ['back']]);
[$status, $out] = post($jar, $csrf, ['mode' => 'save', 'hole' => '={name}', 'back' => ['!{name}']]);
check('non-string template', $status, 400);
[$status, $out] = http('GET', 'bookmark_template.php?mode=get', $jar);
check('nothing stored by refused saves', $out['templates'], bookmark_defaults());

[$status, $out] = post($jar, $csrf, ['mode' => 'save', 'hole' => ' {name}-{sig} {class} ', 'back' => '<{name} {system}', 'mask' => '1.0', 'maskID' => '1.0']);
check('save', [$status, $out['result'] ?? null, $out['templates'] ?? null], [200, true, ['hole' => '{name}-{sig} {class}', 'back' => '<{name} {system}']]);
$stmt = $db->prepare('SELECT maskID FROM fork_bookmark_templates');
$stmt->execute();
check('stored for the session mask only', array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN)), [number_format((float) $mask, 1, '.', '')]);

// Everyone on the mask reads the saved templates
$db->prepare('UPDATE characters SET admin = 0 WHERE characterID = ?')->execute([$me['characterID']]);
[$status, $out] = http('GET', 'bookmark_template.php?mode=get', $jar);
check('member reads the saved templates', [$out['templates'], $out['canEdit'], $out['updatedBy'] !== ''], [['hole' => '{name}-{sig} {class}', 'back' => '<{name} {system}'], false, true]);
$db->prepare('UPDATE characters SET admin = 1 WHERE characterID = ?')->execute([$me['characterID']]);

// A stored template that is no longer valid is not served
$db->prepare('UPDATE fork_bookmark_templates SET `data` = ? WHERE maskID = ?')->execute([json_encode(['hole' => '"x"{name}', 'back' => '{name}']), $mask]);
[$status, $out] = http('GET', 'bookmark_template.php?mode=get', $jar);
check('bad stored templates fall back to the defaults', $out['templates'], bookmark_defaults());

[$status, $out] = post($jar, $csrf, ['mode' => 'save', 'hole' => '={name} {type}', 'back' => '!{name}']);
check('save again', [$status, $out['templates']['hole'] ?? null], [200, '={name} {type}']);
try {
    $stmt = $db->prepare("SELECT detail FROM fork_mask_audit WHERE maskID = ? AND action = 'bookmarks' ORDER BY id DESC LIMIT 1");
    $stmt->execute([$mask]);
    check('audit trail', $stmt->fetchColumn(), 'hole ={name} {type} / return !{name}');
} catch (PDOException $e) {
    check('audit trail table', $e->getMessage(), '');
}

[$status, $out] = post($jar, $csrf, ['mode' => 'reset']);
check('reset', [$status, $out['templates'] ?? null, $out['updatedBy'] ?? null], [200, bookmark_defaults(), '']);

echo ($failures ? "FAILED $failures of $count\n" : "OK: $count checks\n");
exit($failures ? 1 : 0);
