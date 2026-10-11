<?php
// Fork-owned: tests of public/structures.php (access, validation, mask isolation, add / update / gone, rate limit, have=hash)
// against the dev database. Uses masks that no real user has and removes its rows afterwards.
//   docker compose -f docker-compose.dev.yml exec -T app php structures/tests/structures_endpoint_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../structures.inc.php');

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

const MASK_A = '999999993.1';
const MASK_B = '999999993.2';
const SYSTEM = 31001235;
$keepRate = false;

/** Run the endpoint in a separate PHP process. @return [status, decoded body] */
function call($method, $params = [], $session = null, $xhr = true, $headers = []) {
    global $mysql, $keepRate;
    if (!$keepRate) $mysql->exec('DELETE FROM fork_structure_writes WHERE userID IN (900021, 900022)');
    $request = [
        'method' => $method,
        'get' => $method === 'GET' ? $params : [],
        'post' => $method === 'POST' ? $params : [],
        'session' => $session === null ? ['userID' => 900021, 'mask' => MASK_A, 'characterName' => 'Test Pilot'] : $session,
        'headers' => ($xhr ? ['X-Requested-With' => 'XMLHttpRequest'] : []) + $headers,
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
    $mysql->exec('DELETE FROM fork_structures WHERE maskID IN (' . MASK_A . ', ' . MASK_B . ')');
    $mysql->exec('DELETE FROM fork_structure_writes WHERE userID IN (900021, 900022)');
}

structures_schema($mysql);
cleanup($mysql);
$dscan = "35832\tJ163701 - Home Base\tAstrahus\t10 km\n35833\tJ123456 - Elsewhere\tFortizar\t10 km\n22456\tSabre\tSabre\t1 km";

// --- Access and validation ---
check('no session: 403', call('GET', [], [])[0], 403);
check('GET without action: 400', call('GET', ['systemID' => SYSTEM])[0], 400);
check('bad systemID: 400', call('GET', ['action' => 'list', 'systemID' => '12'])[0], 400);
check('POST without X-Requested-With: 400', call('POST', ['action' => 'scan', 'systemID' => SYSTEM, 'text' => $dscan], null, false)[0], 400);
check('unknown action: 400', call('POST', ['action' => 'nope'])[0], 400);
check('PUT: 405', call('PUT')[0], 405);

// --- Scan ---
[$status, $body] = call('POST', ['action' => 'scan', 'systemID' => SYSTEM, 'text' => $dscan, 'systemName' => 'J163701']);
check('scan: 200, one added, the other named for another system', [$status, $body['result']['added'], $body['result']['wrongSystem'], $body['result']['notRecognised']], [200, 1, 1, 1]);
check('scan returns the list', array_map(function ($r) { return $r['typeName']; }, $body['structures']), ['Astrahus']);
$id = $body['structures'][0]['id'];
[$status, $body] = call('POST', ['action' => 'scan', 'systemID' => SYSTEM, 'text' => $dscan, 'systemName' => 'J163701', 'keep' => '[]']);
check('scan with nothing kept changes nothing', [$body['result']['added'], $body['result']['updated']], [0, 0]);
[$status, $body] = call('POST', ['action' => 'scan', 'systemID' => SYSTEM, 'text' => $dscan, 'keep' => 'nonsense']);
check('bad keep: 400', $status, 400);

// --- List, have=hash ---
[$status, $body] = call('GET', ['action' => 'list', 'systemID' => SYSTEM]);
check('list: rows and hash', [count($body['structures']), strlen($body['hash'])], [1, 32]);
[$status, $unchanged] = call('GET', ['action' => 'list', 'systemID' => SYSTEM, 'have' => $body['hash']]);
check('list with the current hash is unchanged', [isset($unchanged['unchanged']), isset($unchanged['structures'])], [true, false]);

// --- Mask isolation ---
$other = ['userID' => 900022, 'mask' => MASK_B, 'characterName' => 'Other Pilot'];
check('other mask sees nothing', call('GET', ['action' => 'list', 'systemID' => SYSTEM], $other)[1]['structures'], []);
check('update of another mask\'s row: 404', call('POST', ['action' => 'update', 'id' => $id, 'state' => 'online'], $other)[0], 404);
check('gone of another mask\'s row: 404', call('POST', ['action' => 'gone', 'id' => $id, 'state' => 'destroyed'], $other)[0], 404);
check('the row is untouched', call('GET', ['action' => 'list', 'systemID' => SYSTEM])[1]['structures'][0]['state'], 'unknown');

// --- Update ---
$eve = gmdate('Y-m-d H:i', time() + 4 * 3600);
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'timerKind' => 'armor', 'timerAt' => $eve, 'owner' => 'Totally Unknown Corp', 'note' => '<b>x</b>']);
$row = $body['structures'][0];
check('update: timer, reinforced, unresolved owner, setter', [$status, $row['timerKind'], $row['state'], $row['ownerText'], $row['timerSetBy'], $row['note']],
    [200, 'armor', 'reinforced', 'Totally Unknown Corp', 'Test Pilot', '<b>x</b>']);
check('update: timer in the future', $row['timerAt'] > time() + 3 * 3600, true);
check('update: timer too old: 400', call('POST', ['action' => 'update', 'id' => $id, 'timerKind' => 'hull', 'timerAt' => gmdate('Y-m-d H:i', time() - 3 * 3600)])[0], 400);
check('update: timer too far: 400', call('POST', ['action' => 'update', 'id' => $id, 'timerKind' => 'hull', 'timerAt' => gmdate('Y-m-d H:i', time() + 40 * 86400)])[0], 400);
check('update: bad state: 400', call('POST', ['action' => 'update', 'id' => $id, 'state' => 'destroyed'])[0], 400);
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'seenNow' => '1']);
check('seen now', $body['structures'][0]['lastSeenBy'], 'Test Pilot');
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'timerKind' => '']);
check('clearing the timer', [$body['structures'][0]['timerKind'], $body['structures'][0]['timerAt']], [null, null]);

// An ended timer (3 h ago) is cleared by the next edit
$mysql->exec("UPDATE fork_structures SET timerKind = 'armor', timerAt = UTC_TIMESTAMP() - INTERVAL 3 HOUR WHERE id = $id");
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'note' => 'edited']);
check('an edit clears an ended timer', [$body['structures'][0]['timerKind'], $body['structures'][0]['note']], [null, 'edited']);

// A timer with seconds keeps them; editing an ended timer's row without touching the timer works (note only)
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'timerKind' => 'hull', 'timerAt' => gmdate('Y-m-d H:i:s', time() + 3605)]);
check('timer keeps seconds', abs($body['structures'][0]['timerAt'] - (time() + 3605)) <= 2, true);
$mysql->exec("UPDATE fork_structures SET timerKind = 'armor', timerAt = UTC_TIMESTAMP() - INTERVAL 3 HOUR WHERE id = $id");
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'state' => 'online', 'note' => 'ended timer row']);
check('editing a row with an ended timer is not blocked', [$status, $body['structures'][0]['state']], [200, 'online']);

// --- Fresh database: the owner cache table may not exist yet ---
$mysql->exec('DROP TABLE IF EXISTS fork_pilot_entities');
[$status, $body] = call('POST', ['action' => 'update', 'id' => $id, 'owner' => 'Some Corp']);
check('owner on a database without fork_pilot_entities: 200, kept as text', [$status, $body['structures'][0]['ownerText']], [200, 'Some Corp']);

// --- Lists don't prune, but hide what a prune would delete ---
$mysql->exec("INSERT INTO fork_structures (maskID, systemID, typeID, typeName, kind, name, firstSeenAt, lastSeenAt, updatedAt) VALUES
    (" . MASK_A . ", " . SYSTEM . ", 33474, 'Mobile Depot', 'deployable', 'old depot', UTC_TIMESTAMP() - INTERVAL 20 DAY, UTC_TIMESTAMP() - INTERVAL 20 DAY, UTC_TIMESTAMP())");
$names = array_map(function ($r) { return $r['name']; }, call('GET', ['action' => 'list', 'systemID' => SYSTEM])[1]['structures']);
check('a stale deployable is not listed', in_array('old depot', $names, true), false);
check('...and a list does not delete it', (int) $mysql->query("SELECT COUNT(*) FROM fork_structures WHERE name = 'old depot'")->fetchColumn(), 1);
call('POST', ['action' => 'update', 'id' => $id, 'seenNow' => '1']);
check('a write prunes it', (int) $mysql->query("SELECT COUNT(*) FROM fork_structures WHERE name = 'old depot'")->fetchColumn(), 0);

// --- Add ---
check('add: a POS module is refused: 400', call('POST', ['action' => 'add', 'systemID' => SYSTEM, 'typeName' => 'Warp Scrambling Battery'])[0], 400);
[$status, $body] = call('POST', ['action' => 'add', 'systemID' => SYSTEM, 'typeName' => 'Fortizar', 'name' => 'Fort Knox', 'state' => 'online']);
check('add: row with type from types.json', [$status, $body['structures'][1]['typeID'], $body['structures'][1]['kind'], $body['structures'][1]['state']] , [200, 35833, 'upwell', 'online']);
[$status, $body] = call('POST', ['action' => 'add', 'systemID' => SYSTEM, 'typeName' => 'Unknown structure']);
check('add: unknown structure', [$status, $body['added'] > 0], [200, true]);
check('add: a ship is not a structure: 400', call('POST', ['action' => 'add', 'systemID' => SYSTEM, 'typeName' => 'Sabre'])[0], 400);
check('add: no type: 400', call('POST', ['action' => 'add', 'systemID' => SYSTEM])[0], 400);
[$status, $body] = call('POST', ['action' => 'add', 'systemID' => SYSTEM, 'typeName' => 'Athanor', 'timerKind' => 'hull', 'timerAt' => gmdate('Y-m-d H:i', time() + 3600)]);
$athanor = array_values(array_filter($body['structures'], function ($r) { return $r['typeName'] === 'Athanor'; }))[0];
check('add with a timer', [$athanor['timerKind'], $athanor['state'], $athanor['timerSetBy']], ['hull', 'reinforced', 'Test Pilot']);

// --- Gone and undo ---
[$status, $body] = call('POST', ['action' => 'gone', 'id' => $id, 'state' => 'destroyed']);
check('destroyed: moves to gone', [count($body['gone']), $body['gone'][0]['state'], $body['gone'][0]['goneBy']], [1, 'destroyed', 'Test Pilot']);
check('gone: bad state: 400', call('POST', ['action' => 'gone', 'id' => $id, 'state' => 'online'])[0], 400);
check('a gone row cannot be edited: 404', call('POST', ['action' => 'update', 'id' => $id, 'note' => 'x'])[0], 404);
[$status, $body] = call('POST', ['action' => 'gone', 'id' => $id, 'state' => 'restore']);
check('restore', [count($body['gone']), count($body['structures'])], [0, 4]);

check('add: a Control Tower is fine', call('POST', ['action' => 'add', 'systemID' => SYSTEM, 'typeName' => 'Caldari Control Tower'])[0], 200);

// --- Markers and timers (GET, no X-Requested-With needed) ---
call('POST', ['action' => 'update', 'id' => $athanor['id'], 'owner' => 'Hostile Text Corp']);
[$status, $body] = call('GET', ['action' => 'markers', 'systemIDs' => SYSTEM . ',' . (SYSTEM + 1)]);
check('markers: systems with structures, next timers, hash', [$status, array_keys((array) $body['systems']), count($body['next']) >= 1, strlen($body['hash'])], [200, [SYSTEM], true, 32]);
check('markers: summary of the system', [$body['systems'][SYSTEM]['count'], $body['systems'][SYSTEM]['nextTimer']['kind']], [5, 'hull']);
[$status, $unchanged] = call('GET', ['action' => 'markers', 'systemIDs' => SYSTEM . ',' . (SYSTEM + 1), 'have' => $body['hash']]);
check('markers: an unchanged have= answers {unchanged}', [$unchanged['unchanged'] ?? null, isset($unchanged['systems'])], [true, false]);
check('markers: a systemID that is not a system: 400', call('GET', ['action' => 'markers', 'systemIDs' => '12'])[0], 400);
check('markers: more than 500 systems: 400', call('GET', ['action' => 'markers', 'systemIDs' => implode(',', range(31000001, 31000501))])[0], 400);
check('markers: no systems is an empty answer', [call('GET', ['action' => 'markers'])[0], (array) call('GET', ['action' => 'markers'])[1]['systems']], [200, []]);
check('markers: another mask sees nothing', [(array) call('GET', ['action' => 'markers', 'systemIDs' => (string) SYSTEM], $other)[1]['systems'], call('GET', ['action' => 'markers', 'systemIDs' => (string) SYSTEM], $other)[1]['next']], [[], []]);
[$status, $body] = call('GET', ['action' => 'timers']);
check('timers: the active timers of the mask', [$status, array_map(function ($r) { return $r['typeName']; }, $body['timers'])], [200, ['Athanor']]);
check('timers: no session: 403', call('GET', ['action' => 'timers'], [])[0], 403);
check('timers: another mask sees nothing', call('GET', ['action' => 'timers'], $other)[1]['timers'], []);

// --- Rate limit: 20 writes a minute ---
$mysql->exec('DELETE FROM fork_structure_writes WHERE userID = 900021');
$keepRate = true;
$statuses = [];
for ($i = 0; $i < 22; $i++) $statuses[] = call('POST', ['action' => 'update', 'id' => $id, 'seenNow' => '1'])[0];
check('21st write in a minute: 429', [count(array_filter($statuses, function ($s) { return $s === 200; })), $statuses[20]], [20, 429]);

cleanup($mysql);
fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
