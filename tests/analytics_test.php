<?php
// Fork-owned: tests for the product analytics (analytics/analytics.inc.php, public/fork_events.php, analytics_prune.cron.php)
// against the dev stack's database and nginx/PHP. Fake account ids 99190xx only; their rows are deleted at the end and the
// salt is put back as it was.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/analytics_test.php
// 1. Request parsing: catalog whitelist, action pattern, merging, clamping, size caps.
// 2. CSRF: session token, Origin, Sec-Fetch-Site.
// 3. Pseudonyms: stable uid, salt rotation (old salt gone, new uid), mask hash.
// 4. Writing: counters add up, milestones, masks only for use actions, tables created on first use, raw events.
// 5. Prune: old rows go, recent rows stay, raw table dropped when off.
// 6. public/fork_events.php over HTTP: token from mode=get, 204 always, nothing recorded without session/token/origin.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('ANALYTICS_TEST_BASE') ?: 'http://127.0.0.1';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
require_once(__DIR__ . '/../analytics/analytics.inc.php');   // no config.php: settings come from putenv below

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
const ACC_A = 9919001, ACC_B = 9919002;
const MASK_A = '991901.0';
function salt_row() { global $db; try { return $db->query("SELECT v FROM fork_analytics_meta WHERE k = 'salt'")->fetchColumn(); } catch (PDOException $e) { return false; } }
function uid_of($account) { global $db; return analytics_hash(analytics_salt($db), 'account', $account); }
function rows($uid, $table = 'fork_analytics_daily') {
    global $db;
    $cols = $table === 'fork_analytics_daily' ? 'feature, action, n' : 'feature, action, n, firstAt <= lastAt AS ok';
    $stmt = $db->prepare("SELECT $cols FROM $table WHERE uid = ? ORDER BY feature, action");
    $stmt->execute([$uid]);
    return $stmt->fetchAll(PDO::FETCH_NUM);
}
$uids = [];
function cleanup() {
    global $db, $uids;
    foreach (array_unique($uids) as $u) {
        foreach (['fork_analytics_daily', 'fork_analytics_user'] as $t) {
            try { $db->prepare("DELETE FROM $t WHERE uid = ?")->execute([$u]); } catch (PDOException $e) { if ($e->getCode() !== '42S02') throw $e; }
        }
    }
    foreach (glob('/var/lib/php/session/sess_analyticstest*') ?: [] as $f) @unlink($f);
}

putenv('ANALYTICS_ENABLED=true');
putenv('ANALYTICS_DAYS=90');
putenv('ANALYTICS_RAW_DAYS=0');
$savedSalt = salt_row();
$catalog = analytics_catalog();

// ---- 1. parsing ----
check('catalog loaded', isset($catalog['jumpPlanner'], $catalog['app']), true);
check('generic and own actions allowed', [analytics_allowed($catalog, 'jumpPlanner', 'opened'), analytics_allowed($catalog, 'jumpPlanner', 'route_planned'), analytics_allowed($catalog, 'sizeTags', 'shown')], [true, true, true]);
check('other features\' actions refused', analytics_allowed($catalog, 'sizeTags', 'route_planned'), false);
check('internal ids take their own actions only', [analytics_allowed($catalog, 'app', 'active'), analytics_allowed($catalog, 'app', 'opened')], [true, false]);
check('unknown feature / bad action refused', [analytics_allowed($catalog, 'J123456', 'opened'), analytics_allowed($catalog, 'jumpPlanner', 'Opened'), analytics_allowed($catalog, 'jumpPlanner', 'a b'), analytics_allowed($catalog, 'jumpPlanner', str_repeat('a', 25))], [false, false, false, false]);
$p = analytics_parse(json_encode(['t' => 'tok', 'e' => [
    ['f' => 'jumpPlanner', 'a' => 'opened', 'n' => 2],
    ['f' => 'jumpPlanner', 'a' => 'opened', 'n' => 3],
    ['f' => 'sizeTags', 'a' => 'shown', 'n' => 99999],
    ['f' => 'sizeTags', 'a' => 'shown', 'n' => -4],
    ['f' => 'Jita', 'a' => 'opened'],
    ['f' => 'jumpPlanner', 'a' => 'system_30000142'],
    ['f' => 5, 'a' => 'opened'],
    'junk',
]]), $catalog);
check('parse: token', $p['token'], 'tok');
check('parse: whitelist, merge, clamp', $p['entries'], [['jumpPlanner', 'opened', 5], ['sizeTags', 'shown', 1000]]);
check('parse: not JSON / wrong shape / nested too deep', [analytics_parse('nope', $catalog), analytics_parse('{"e": {"a": 1}}', $catalog), analytics_parse('', $catalog), analytics_parse('{"e": [{"f": [[1]]}]}', $catalog)], [null, null, null, null]);
check('parse: over 8 KB refused', analytics_parse(json_encode(['t' => str_repeat('x', 9000), 'e' => []]), $catalog), null);
$many = [];
for ($i = 0; $i < 80; $i++) $many[] = ['f' => 'jumpPlanner', 'a' => 'opened', 'n' => 1];
$p = analytics_parse(json_encode(['t' => '', 'e' => $many]), $catalog);
check('parse: at most 50 entries read', $p['entries'], [['jumpPlanner', 'opened', 50]]);

// ---- 2. CSRF ----
$tok = str_repeat('ab', 32);
check('request: right token, same origin', analytics_request_ok($tok, $tok, ['HTTP_ORIGIN' => 'http://tw.test:8400', 'HTTP_HOST' => 'tw.test:8400', 'HTTP_SEC_FETCH_SITE' => 'same-origin']), true);
check('request: right token, no Origin (old browser)', analytics_request_ok($tok, $tok, ['HTTP_HOST' => 'tw.test']), true);
check('request: wrong token', analytics_request_ok($tok, str_repeat('cd', 32), ['HTTP_HOST' => 'tw.test']), false);
check('request: no session token', analytics_request_ok('', '', ['HTTP_HOST' => 'tw.test']), false);
check('request: other origin', analytics_request_ok($tok, $tok, ['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_HOST' => 'tw.test']), false);
check('request: cross-site fetch', analytics_request_ok($tok, $tok, ['HTTP_SEC_FETCH_SITE' => 'cross-site', 'HTTP_HOST' => 'tw.test']), false);

// ---- 3. pseudonyms (and tables created on first use) ----
foreach (['fork_analytics_daily', 'fork_analytics_user', 'fork_analytics_mask', 'fork_analytics_raw'] as $t) $db->exec("DROP TABLE IF EXISTS $t");
$db->exec("DELETE FROM fork_analytics_meta WHERE k = 'salt'");
$salt = analytics_salt($db);
check('salt: 32 bytes, stored with today\'s date', [strlen($salt), substr((string) salt_row(), 0, 10)], [32, gmdate('Y-m-d')]);
check('salt: stable', analytics_salt($db) === $salt, true);
$uidA = uid_of(ACC_A);
$uids[] = $uidA;
$uids[] = uid_of(ACC_B);
check('uid: 16 hex characters, stable, per account', [strlen($uidA), ctype_xdigit($uidA), uid_of(ACC_A) === $uidA, uid_of(ACC_B) !== $uidA], [16, true, true, true]);
check('uid: not a plain hash of the id', in_array($uidA, [substr(hash('sha256', (string) ACC_A), 0, 16), substr(md5((string) ACC_A), 0, 16)], true), false);
$old = salt_row();
$db->prepare("UPDATE fork_analytics_meta SET v = ? WHERE k = 'salt'")->execute([gmdate('Y-m-d', time() - 91 * 86400) . substr($old, 10)]);
$newSalt = analytics_salt($db);
check('salt: replaced after ANALYTICS_DAYS, old one gone', [$newSalt !== $salt, strpos((string) salt_row(), bin2hex($salt)) === false, (int) $db->query("SELECT COUNT(*) FROM fork_analytics_meta WHERE k = 'salt'")->fetchColumn()], [true, true, 1]);
$uidA2 = uid_of(ACC_A);
$uids[] = $uidA2;
$uids[] = uid_of(ACC_B);
check('uid: new after rotation', $uidA2 !== $uidA, true);
check('salt: not replaced before ANALYTICS_DAYS', analytics_salt($db, 90, time() + 89 * 86400) === $newSalt, true);

// ---- 4. writing ----
$n = analytics_record($db, ACC_A, MASK_A, [['jumpPlanner', 'opened', 2], ['sizeTags', 'shown', 1], ['nope', 'opened', 1]]);
check('record: tables created on first use, unknown entry skipped', $n, 2);
analytics_record($db, ACC_A, MASK_A, [['jumpPlanner', 'opened', 3], ['app', 'active', 1]]);
check('record: daily counters add up', rows($uidA2), [['app', 'active', 1], ['jumpPlanner', 'opened', 5], ['sizeTags', 'shown', 1]]);
check('record: milestones', rows($uidA2, 'fork_analytics_user'), [['app', 'active', 1, 1], ['jumpPlanner', 'opened', 5, 1], ['sizeTags', 'shown', 1, 1]]);
$mh = analytics_hash($newSalt, 'mask', MASK_A);
$stmt = $db->prepare('SELECT feature FROM fork_analytics_mask WHERE maskHash = ? ORDER BY feature');
$stmt->execute([$mh]);
check('record: masks using, for use actions only', $stmt->fetchAll(PDO::FETCH_COLUMN), ['jumpPlanner']);
check('record: no ids or names stored', (int) $db->query("SELECT COUNT(*) FROM fork_analytics_daily WHERE uid IN ('" . ACC_A . "', '" . MASK_A . "')")->fetchColumn(), 0);
check('record: no raw table while ANALYTICS_RAW_DAYS=0', $db->query("SHOW TABLES LIKE 'fork_analytics_raw'")->fetchColumn(), false);
putenv('ANALYTICS_RAW_DAYS=7');
analytics_record($db, ACC_A, MASK_A, [['jumpPlanner', 'command', 1]]);
check('record: raw events with ANALYTICS_RAW_DAYS>0 (table created)', (int) $db->query("SELECT COUNT(*) FROM fork_analytics_raw WHERE uid = '$uidA2'")->fetchColumn(), 1);
putenv('ANALYTICS_ENABLED=false');
check('record: nothing when ANALYTICS_ENABLED=false', analytics_record($db, ACC_A, MASK_A, [['jumpPlanner', 'opened', 1]]), 0);
putenv('ANALYTICS_ENABLED=true');
check('record: no account, nothing', analytics_record($db, 0, MASK_A, [['jumpPlanner', 'opened', 1]]), 0);

// ---- 5. prune ----
$db->prepare('INSERT INTO fork_analytics_daily (day, feature, action, uid, n, firstMinute) VALUES (DATE_SUB(UTC_DATE(), INTERVAL 91 DAY), ?, ?, ?, 1, 0)')->execute(['jumpPlanner', 'opened', $uidA2]);
$db->prepare('INSERT INTO fork_analytics_user (uid, feature, action, firstAt, lastAt, n) VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 100 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 91 DAY), 1)')->execute([$uidA2, 'whatsNew', 'opened']);
$db->prepare('INSERT INTO fork_analytics_raw (at, uid, feature, action, n) VALUES (DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY), ?, ?, ?, 1)')->execute([$uidA2, 'jumpPlanner', 'opened']);
$deleted = analytics_prune($db, 90, 7);
check('prune: old rows deleted', $deleted >= 3, true);
check('prune: recent rows kept', rows($uidA2), [['app', 'active', 1], ['jumpPlanner', 'command', 1], ['jumpPlanner', 'opened', 5], ['sizeTags', 'shown', 1]]);
check('prune: old milestone gone', array_column(rows($uidA2, 'fork_analytics_user'), 0), ['app', 'jumpPlanner', 'jumpPlanner', 'sizeTags']);
check('prune: recent raw event kept', (int) $db->query("SELECT COUNT(*) FROM fork_analytics_raw WHERE uid = '$uidA2'")->fetchColumn(), 1);
putenv('ANALYTICS_RAW_DAYS=0');
analytics_prune($db);
check('prune: raw table dropped when ANALYTICS_RAW_DAYS=0', $db->query("SHOW TABLES LIKE 'fork_analytics_raw'")->fetchColumn(), false);
exec('cd ' . escapeshellarg(getcwd()) . ' && php analytics_prune.cron.php 2>&1', $out, $rc);
check('prune cron runs', $rc, 0);

// ---- 6. HTTP ----
function sess($name, array $data) {
    $sid = 'analyticstest' . $name;
    $payload = '';
    foreach ($data as $k => $v) $payload .= $k . '|' . serialize($v);
    $path = '/var/lib/php/session/sess_' . $sid;
    file_put_contents($path, $payload);
    @chown($path, 'www-data');
    @chmod($path, 0600);
    return $sid;
}
function http($method, $path, $sid, $body = null, array $headers = []) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    $h = array_merge($sid ? ['Cookie: PHPSESSID=' . $sid] : [], $headers);
    $opts = [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 20];
    if ($body !== null) $opts[CURLOPT_POSTFIELDS] = $body;
    curl_setopt_array($ch, $opts);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, (string) $text];
}
$sid = sess('user', ['userID' => ACC_B, 'mask' => MASK_A, 'characterID' => 991901]);
list($st, $text) = http('GET', 'fork_events.php?mode=get', null);
check('http: mode=get without login: no token', [$st, json_decode($text, true)], [200, ['enabled' => false, 'token' => '']]);
list($st, $text) = http('GET', 'fork_events.php?mode=get', $sid);
$got = json_decode($text, true);
$token = $got['token'] ?? '';
check('http: mode=get gives a token', [$st, $got['enabled'] ?? null, strlen($token)], [200, true, 64]);
list(, $text2) = http('GET', 'fork_events.php?mode=get', $sid);
check('http: the token is per session (same on the next get)', json_decode($text2, true)['token'] ?? '', $token);
$uidB = uid_of(ACC_B);
$body = function ($t, $f = 'jumpPlanner', $a = 'opened') { return json_encode(['t' => $t, 'e' => [['f' => $f, 'a' => $a, 'n' => 1]]]); };
$plain = ['Content-Type: text/plain;charset=UTF-8'];
list($st, $text) = http('POST', 'fork_events.php', $sid, $body($token), array_merge($plain, ['Origin: ' . $base, 'Sec-Fetch-Site: same-origin']));
check('http: POST 204, empty', [$st, $text], [204, '']);
check('http: POST recorded', rows($uidB), [['jumpPlanner', 'opened', 1]]);
list($st) = http('POST', 'fork_events.php', $sid, $body(str_repeat('0', 64)), $plain);
check('http: wrong token: 204, not recorded', [$st, rows($uidB)], [204, [['jumpPlanner', 'opened', 1]]]);
list($st) = http('POST', 'fork_events.php', $sid, $body($token), array_merge($plain, ['Origin: https://evil.example']));
check('http: other origin: 204, not recorded', [$st, rows($uidB)], [204, [['jumpPlanner', 'opened', 1]]]);
list($st) = http('POST', 'fork_events.php', $sid, $body($token), array_merge($plain, ['Sec-Fetch-Site: cross-site']));
check('http: cross-site: 204, not recorded', [$st, rows($uidB)], [204, [['jumpPlanner', 'opened', 1]]]);
list($st) = http('POST', 'fork_events.php', $sid, $body($token, 'J123456'), $plain);
check('http: unknown feature: 204, not recorded', [$st, rows($uidB)], [204, [['jumpPlanner', 'opened', 1]]]);
list($st) = http('POST', 'fork_events.php', null, $body($token), $plain);
check('http: no session: 204, not recorded', [$st, rows($uidB)], [204, [['jumpPlanner', 'opened', 1]]]);
list($st) = http('POST', 'fork_events.php', $sid, str_repeat('x', 9000), $plain);
check('http: oversized body: 204', $st, 204);
list($st) = http('PUT', 'fork_events.php', $sid, $body($token), $plain);
check('http: other methods 405', $st, 405);

cleanup();
if ($savedSalt !== false) {
    $db->prepare("REPLACE INTO fork_analytics_meta (k, v) VALUES ('salt', ?)")->execute([$savedSalt]);
}
echo ($failures ? "FAILED $failures of $count checks\n" : "OK: $count checks\n");
exit($failures ? 1 : 0);
