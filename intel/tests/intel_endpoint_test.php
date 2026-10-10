<?php
// Fork-owned: tests of public/intel_scans.php (validation, mask isolation, deletion) and of the pruning in
// intel/intel.inc.php, against the dev database. Uses masks that no real user has and removes its rows afterwards.
//   docker compose -f docker-compose.dev.yml exec -T app php intel/tests/intel_endpoint_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../intel.inc.php');

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

const MASK_A = '999999990.1';
const MASK_B = '999999990.2';
const SYSTEM = 31000005;	// Thera
const OTHER_SYSTEM = 30000142;	// Jita

/** Run the endpoint in a separate PHP process. @return [status, decoded body] */
function call($method, $params = [], $session = null, $xhr = true) {
    $request = [
        'method' => $method,
        'get' => $method === 'GET' ? $params : [],
        'post' => $method === 'POST' ? $params : [],
        'session' => $session === null ? ['userID' => 900001, 'mask' => MASK_A, 'characterName' => 'Test Pilot'] : $session,
        'headers' => $xhr ? ['X-Requested-With' => 'XMLHttpRequest'] : [],
    ];
    $proc = proc_open(['php', __DIR__ . '/endpoint_runner.php'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    fwrite($pipes[0], json_encode($request));
    fclose($pipes[0]);
    $body = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    proc_close($proc);
    $status = preg_match('/STATUS (\d+)/', $err, $m) ? (int) $m[1] : 0;
    return [$status, json_decode($body, true)];
}

function cleanup($mysql) {
    $mysql->exec("DELETE FROM fork_intel_scans WHERE maskID IN (" . MASK_A . ", " . MASK_B . ")");
}

intel_schema($mysql);
cleanup($mysql);

$dscan = "22456\tBob's Sabre\tSabre\t1,234 km\n12034\t<img src=x onerror=alert(1)>\tHound\t12 km\n670\tCapsule\tCapsule\t-";

// --- Access and validation ---
check('no session: 403', call('GET', [], [])[0], 403);
check('POST without X-Requested-With: 400', call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => $dscan], null, false)[0], 400);
check('unknown mode: 400', call('POST', ['mode' => 'nope'])[0], 400);
check('bad systemID: 400', call('POST', ['mode' => 'add', 'systemID' => '12', 'text' => $dscan])[0], 400);
check('systemID not a number: 400', call('GET', ['systemID' => 'abc'])[0], 400);
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => "<b>\n!!"]);
check('nothing valid pasted: 400 with message', [$status, isset($body['error'])], [400, true]);
check('too big: 400', call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => str_repeat('a', INTEL_MAX_BYTES + 1)])[0], 400);
check('PUT: 405', call('PUT')[0], 405);

// --- Add and list ---
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => $dscan]);
check('add d-scan: 200', $status, 200);
check('add returns the id', is_int($body['added'] ?? null), true);
check('add returns the system scans', count($body['scans'] ?? []), 1);
$scan = $body['scans'][0];
check('stored kind', $scan['kind'], 'dscan');
check('stored rows (normalised, hostile text kept as data)', $scan['data']['rows'][1], [12034, 'Hound', '<img src=x onerror=alert(1)>', 12]);
check('creator and mine', [$scan['createdBy'], $scan['mine']], ['Test Pilot', true]);
check('latest has the system', isset($body['latest'][(string) SYSTEM]['dscan']), true);
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => "Chribba\nSome Pilot\nchribba"]);
check('add local', [$status, $body['scans'][0]['kind'], $body['scans'][0]['data']['names']], [200, 'local', ['Chribba', 'Some Pilot']]);

// --- Payload: rows only for scans the browser doesn't have ---
[$status, $body] = call('GET', ['systemID' => SYSTEM]);
check('without have: rows of every scan', array_map(function ($s) { return isset($s['data']); }, $body['scans']), [true, true]);
$ids = array_map(function ($s) { return $s['id']; }, $body['scans']);
[$status, $body] = call('GET', ['systemID' => SYSTEM, 'have' => implode(',', $ids)]);
check('with have: metadata only', array_map(function ($s) { return array_keys($s); }, $body['scans']),
    [['id', 'systemID', 'kind', 'createdBy', 'mine', 'age'], ['id', 'systemID', 'kind', 'createdBy', 'mine', 'age']]);
[$status, $body] = call('GET', ['systemID' => SYSTEM, 'have' => (string) $ids[1]]);
check('with part of them: rows of the others', array_map(function ($s) { return isset($s['data']); }, $body['scans']), [true, false]);
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => 'Ann Example', 'have' => implode(',', $ids)]);
check('add with have: rows of the new scan only', array_map(function ($s) { return isset($s['data']); }, $body['scans']), [true, false, false]);
$mysql->exec('DELETE FROM fork_intel_scans WHERE id = ' . (int) $body['added']);

// --- Other masks and users ---
[$status, $body] = call('GET', ['systemID' => SYSTEM], ['userID' => 900002, 'mask' => MASK_B]);
check('other mask sees nothing', [$status, $body['scans'], (array) $body['latest']], [200, [], []]);
[$status, $body] = call('GET', ['systemID' => SYSTEM], ['userID' => 900002, 'mask' => MASK_A]);
check('same mask, other user: sees both, not mine', [count($body['scans']), $body['scans'][0]['mine']], [2, false]);
$id = $body['scans'][0]['id'];
[$status, $body] = call('POST', ['mode' => 'delete', 'id' => $id, 'systemID' => SYSTEM], ['userID' => 900002, 'mask' => MASK_A]);
check("can't delete another user's scan", [$status, $body['deleted'], count($body['scans'])], [200, false, 2]);
[$status, $body] = call('POST', ['mode' => 'delete', 'id' => $id, 'systemID' => SYSTEM], ['userID' => 900001, 'mask' => MASK_B]);
check("can't delete from another mask", $body['deleted'], false);
[$status, $body] = call('POST', ['mode' => 'delete', 'id' => $id, 'systemID' => SYSTEM]);
check('delete own scan', [$status, $body['deleted'], count($body['scans'])], [200, true, 1]);
check('delete: bad id', call('POST', ['mode' => 'delete', 'id' => 'x'])[0], 400);

// --- Pruning ---
cleanup($mysql);
$data = ['names' => ['A Pilot'], 'invalid' => 0];
$expired = intel_insert($mysql, MASK_A, SYSTEM, 'local', $data, 'Old', 900001, INTEL_RETENTION_H * 3600 + 60);
$fresh = intel_insert($mysql, MASK_A, OTHER_SYSTEM, 'local', $data, 'New', 900001, 30);
check('expired rows are not listed', count(intel_list($mysql, MASK_A, SYSTEM, 900001)), 0);
check('latest skips expired rows', array_keys(intel_latest($mysql, MASK_A)), [OTHER_SYSTEM]);
check('latest age', intel_latest($mysql, MASK_A)[(string) OTHER_SYSTEM]['local'] >= 30, true);
intel_prune($mysql);
$left = array_map('intval', $mysql->query('SELECT id FROM fork_intel_scans WHERE maskID IN (' . MASK_A . ', ' . MASK_B . ') ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
check('prune deletes expired rows only', $left, [$fresh]);
$inserted = [];
for ($i = 0; $i < INTEL_MAX_PER_SYSTEM + 5; $i++) {
    $inserted[] = intel_insert($mysql, MASK_A, SYSTEM, 'local', $data, 'Pilot', 900003, 1000 - 10 * $i);	// oldest first
}
intel_insert($mysql, MASK_B, SYSTEM, 'local', $data, 'Pilot', 900003, 0);
intel_prune($mysql, MASK_A, SYSTEM);
$perSystem = (int) $mysql->query('SELECT COUNT(*) FROM fork_intel_scans WHERE maskID = ' . MASK_A . ' AND systemID = ' . SYSTEM)->fetchColumn();
check('prune keeps the newest per system', $perSystem, INTEL_MAX_PER_SYSTEM);
$kept = array_map('intval', $mysql->query('SELECT id FROM fork_intel_scans WHERE maskID = ' . MASK_A . ' AND systemID = ' . SYSTEM . ' ORDER BY id')->fetchAll(PDO::FETCH_COLUMN));
check('the oldest ones went', $kept, array_slice($inserted, 5));
check('other systems and masks untouched', (int) $mysql->query('SELECT COUNT(*) FROM fork_intel_scans WHERE (maskID = ' . MASK_A . ' AND systemID = ' . OTHER_SYSTEM . ') OR maskID = ' . MASK_B)->fetchColumn(), 2);

// --- Rate limit ---
cleanup($mysql);
for ($i = 0; $i < INTEL_RATE_PER_MIN; $i++) {
    intel_insert($mysql, MASK_A, OTHER_SYSTEM, 'local', $data, 'Pilot', 900001, 0);
}
check('rate limit: 429', call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => 'Chribba'])[0], 429);
check('rate limit is per user', call('POST', ['mode' => 'add', 'systemID' => SYSTEM, 'text' => 'Chribba'], ['userID' => 900004, 'mask' => MASK_A])[0], 200);

cleanup($mysql);
echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
