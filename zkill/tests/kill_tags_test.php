<?php
// Fork-owned: tests of the kill tag columns of zkill_killmails (adding them to a table from before, the API shape) and of
// public/fight_now.php (Fight now markers) against the dev database. Uses kill IDs no real data has and removes its rows
// afterwards; the column test drops the tag columns and lets zk_ensure_schema add them back (stored kills lose their tag
// facts, nothing else). Never calls zKillboard or ESI.
//   docker compose -f docker-compose.dev.yml exec -T app php zkill/tests/kill_tags_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../zkill.inc.php');

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

const BASE = 990000200000;        // test kill IDs: BASE .. BASE + 999
const SYS_A = 31002479;           // J100820
const SYS_B = 30001161;           // HED-GP
const SYS_C = 30000142;           // Jita
const SESSION = ['userID' => 900102, 'mask' => '98000001.2'];

/** Run public/fight_now.php in a separate PHP process. @return [status, decoded body] */
function call($params, $session = SESSION, $method = 'GET') {
    $request = ['script' => 'fight_now.php', 'method' => $method, 'get' => $params, 'session' => $session];
    $proc = proc_open(['php', __DIR__ . '/endpoint_runner.php'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    fwrite($pipes[0], json_encode($request));
    fclose($pipes[0]);
    $body = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    proc_close($proc);
    $status = preg_match('/STATUS (\d+)/', $err, $m) ? (int) $m[1] : 0;
    return [$status, json_decode($body, true)];
}

function cleanup(PDO $mysql) {
    $mysql->exec('DELETE FROM zkill_killmails WHERE killID BETWEEN ' . BASE . ' AND ' . (BASE + 999));
}

/** A kill $minutesAgo in $systemID, as the worker stores it (zk_killmail_row) */
function store(PDO $mysql, $n, $systemID, $minutesAgo, array $zkb = [], ?array $attackers = null) {
    $esi = [
        'killmail_id' => BASE + $n, 'killmail_time' => gmdate('Y-m-d\TH:i:s\Z', time() - $minutesAgo * 60), 'solar_system_id' => $systemID,
        'victim' => ['character_id' => 90000001, 'corporation_id' => 98000002, 'ship_type_id' => 587],
        'attackers' => $attackers ?? [['character_id' => 90000002, 'corporation_id' => 98000003, 'ship_type_id' => 22456, 'weapon_type_id' => 3937, 'final_blow' => true]],
    ];
    zk_store_row($mysql, zk_killmail_row($esi + ['zkb' => $zkb + ['hash' => 'h' . $n]]), 'feed');
}

$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
zk_ensure_schema($mysql);
cleanup($mysql);

// --- A table from before the tag columns: the first read adds them (42S22), the next ensure is a no-op ---
$drop = implode(', ', array_map(function ($c) { return "DROP COLUMN `$c`"; }, array_keys(ZK_KILLMAIL_ADDED_COLUMNS)));
$mysql->exec("ALTER TABLE zkill_killmails $drop");
$read = zk_system_kills($mysql, [SYS_A], 3600, 5, ['queue' => false]);
check('old table: read works', is_array($read['kills']), true);
$columns = $mysql->query('SHOW COLUMNS FROM zkill_killmails')->fetchAll(PDO::FETCH_COLUMN);
check('old table: columns added', array_values(array_intersect(array_keys(ZK_KILLMAIL_ADDED_COLUMNS), $columns)), array_keys(ZK_KILLMAIL_ADDED_COLUMNS));
zk_ensure_schema($mysql);
check('ensure again: nothing added twice', count($mysql->query('SHOW COLUMNS FROM zkill_killmails')->fetchAll(PDO::FETCH_COLUMN)), count($columns));

// --- Stored facts come back in the API shape ---
store($mysql, 1, SYS_A, 5, ['locationID' => 50001248, 'labels' => ['ganked']]);
$kill = zk_system_kills($mysql, [SYS_A], 3600, 5, ['queue' => false])['kills'][0];
check('json: tag facts', [$kill['killID'], $kill['locationID'], $kill['attackerShips'], $kill['attackerWeapons'], $kill['concord'], $kill['ganked']],
    [BASE + 1, 50001248, [22456], [3937], false, true]);
$mysql->exec('UPDATE zkill_killmails SET locationID = NULL, attackerShips = \'\', attackerWeapons = \'\' WHERE killID = ' . (BASE + 1));
$kill = zk_system_kills($mysql, [SYS_A], 3600, 5, ['queue' => false])['kills'][0];
check('json: a kill stored before the columns has no facts', [$kill['locationID'], $kill['attackerShips'], $kill['attackerWeapons']], [null, [], []]);
check('json: row without the columns at all', array_intersect_key(zk_kill_json(['id' => 1, 'killID' => 2, 'systemID' => 3, 'killTime' => '2026-01-01 00:00:00',
    'victimCharacterID' => null, 'victimCorporationID' => null, 'victimAllianceID' => null, 'victimShipTypeID' => null, 'finalBlowCharacterID' => null,
    'finalBlowCorporationID' => null, 'finalBlowAllianceID' => null, 'finalBlowShipTypeID' => null, 'attackerCount' => 0, 'attackerTotal' => 0,
    'totalValue' => 0, 'npc' => 0, 'solo' => 0, 'awox' => 0]), array_flip(['locationID', 'attackerShips', 'concord'])),
    ['locationID' => null, 'attackerShips' => [], 'concord' => false]);

// --- zk_fight_now: player kills in the window, per system ---
store($mysql, 2, SYS_A, 20);
store($mysql, 3, SYS_A, 70);                       // outside the hour
store($mysql, 4, SYS_B, 10, ['npc' => true]);      // NPC kill: left out
store($mysql, 5, SYS_C, 50);
$now = time();
$fights = zk_fight_now($mysql, [SYS_A, SYS_B, SYS_C], 3600, $now);
check('fight now: counts', [$fights[SYS_A]['kills'] ?? null, isset($fights[SYS_B]), $fights[SYS_C]['kills'] ?? null], [2, false, 1]);
check('fight now: last kill time', $fights[SYS_A]['lastKill'], gmdate('Y-m-d\TH:i:s\Z', strtotime($mysql->query('SELECT killTime FROM zkill_killmails WHERE killID = ' . (BASE + 1))->fetchColumn() . ' UTC')));
check('fight now: no systems', zk_fight_now($mysql, [], 3600, $now), []);

// --- public/fight_now.php ---
check('endpoint: no session 403', call(['systems' => (string) SYS_A], [])[0], 403);
check('endpoint: POST 405', call(['systems' => (string) SYS_A], SESSION, 'POST')[0], 405);
check('endpoint: junk 400', call(['systems' => SYS_A . ',abc'])[0], 400);
check('endpoint: not a system 400', call(['systems' => '12345'])[0], 400);
check('endpoint: array parameter 400', call(['systems' => [(string) SYS_A]])[0], 400);
check('endpoint: 201 systems 400', call(['systems' => implode(',', range(30000001, 30000201))])[0], 400);
[$status, $body] = call(['systems' => SYS_A . ', ' . SYS_B . ',,' . SYS_C]);
check('endpoint: 200', $status, 200);
check('endpoint: shape', [$body['windowSeconds'], is_array($body['feed']), $body['systems'][(string) SYS_A]['kills'], $body['systems'][(string) SYS_C]['kills'],
    isset($body['systems'][(string) SYS_B])], [3600, true, 2, 1, false]);
[$status, $body] = call(['systems' => '']);
check('endpoint: no systems is an empty object', [$status, $body['systems']], [200, []]);

cleanup($mysql);
echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
