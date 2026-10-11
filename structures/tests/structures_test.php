<?php
// Fork-owned: tests of structures/structures.inc.php. Pure parts (parse, merge, timers; fixtures shared with the mocha
// tests) and the database parts (merge into stored rows, owner cache, prune) against the dev database, with a mask no
// real user has and IDs/names "Zzs ..."; the rows are removed afterwards. No request leaves the container.
//   docker compose -f docker-compose.dev.yml exec -T app php structures/tests/structures_test.php
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

const MASK_A = '999999992.1';
const MASK_B = '999999992.2';
const SYSTEM = 31001234;

$fixtures = json_decode(file_get_contents(__DIR__ . '/fixtures.json'), true);

// --- Parse parity with the browser ---
function floatKm(array $rows) {	// JSON has no float type: 12 in the fixture is 12.0 here
    return array_map(function ($r) { if ($r[4] !== null) $r[4] = (float) $r[4]; return $r; }, $rows);
}
foreach ($fixtures['parse'] as $case) {
    $r = structures_parse_scan(implode("\n", $case['lines']), $case['systemName']);
    check('parse: ' . $case['name'], $r['structures'], floatKm($case['structures']));
    check('parse modules: ' . $case['name'], [$r['modules'], $r['notRecognised'], $r['invalid']], [$case['modules'], $case['notRecognised'], $case['invalid']]);
}

// --- Merge parity ---
foreach ($fixtures['merge'] as $case) {
    check('merge: ' . $case['name'], structures_merge($case['existing'], $case['incoming']), $case['expected']);
}

// --- Names and times ---
check('split J-code', structures_split_name('J163701 - Home'), ['J163701', 'Home']);
check('split plain', structures_split_name('Just a name'), ['', 'Just a name']);
check('time EVE format', structures_parse_time('2026.10.12 18:30'), gmmktime(18, 30, 0, 10, 12, 2026));
check('time ISO Z', structures_parse_time('2026-10-12T18:30:00Z'), gmmktime(18, 30, 0, 10, 12, 2026));
check('time ISO offset', structures_parse_time('2026-10-12T20:30:00+02:00'), gmmktime(18, 30, 0, 10, 12, 2026));
check('time invalid date', structures_parse_time('2026-02-31 10:00'), null);
check('time garbage', structures_parse_time('soon'), null);
$now = 1800000000;
check('timer 2 h in the past is allowed', structures_timer_in_range($now - 7200, $now), true);
check('timer older is refused', structures_timer_in_range($now - 7201, $now), false);
check('timer 30 days ahead is allowed', structures_timer_in_range($now + 2592000, $now), true);
check('timer further is refused', structures_timer_in_range($now + 2592001, $now), false);

// --- Database ---
function cleanup($mysql) {
    $mysql->exec('DELETE FROM fork_structures WHERE maskID IN (' . MASK_A . ', ' . MASK_B . ')');
    $mysql->exec("DELETE FROM fork_pilot_entities WHERE id IN (2100000001, 2100000002, 2100000003)");
    $mysql->exec('DELETE FROM fork_structure_writes WHERE userID = 900011');
}
structures_schema($mysql);
intel_pilots_schema($mysql);
cleanup($mysql);
$friendly = ['corporations' => [2100000001], 'alliances' => []];

$scan = "35832\tJ163701 - Home Base\tAstrahus\t10 km\n16213\t\tCaldari Control Tower\t5,000 km\n17182\t\tWarp Scrambling Battery\t5,100 km\n33474\t\tMobile Depot\t12 km\n33474\t\tMobile Depot\t14 km";
$parsed = structures_parse_scan($scan, 'J163701');
$res = structures_apply_scan($mysql, MASK_A, SYSTEM, $parsed['structures'], $parsed['modules'], 'Scout');
check('first scan adds all rows', $res, ['added' => 4, 'updated' => 0, 'restored' => 0, 'skipped' => 0]);
$list = structures_list($mysql, MASK_A, SYSTEM, $friendly);
check('list has the rows', array_map(function ($r) { return $r['typeName']; }, $list['structures']), ['Astrahus', 'Caldari Control Tower', 'Mobile Depot', 'Mobile Depot']);
check('POS note counts modules once', $list['structures'][1]['note'], '1 modules on the first scan');
check('seen by', [$list['structures'][0]['lastSeenBy'], $list['structures'][0]['lastDistanceKm']], ['Scout', 10.0]);
$res = structures_apply_scan($mysql, MASK_A, SYSTEM, $parsed['structures'], $parsed['modules'], 'Scout 2');
check('the same scan again updates, adds nothing', $res, ['added' => 0, 'updated' => 4, 'restored' => 0, 'skipped' => 0]);
check('mask isolation: another mask sees nothing', structures_list($mysql, MASK_B, SYSTEM, $friendly)['structures'], []);
$id = $list['structures'][0]['id'];
check('mask isolation: get with another mask', structures_get($mysql, MASK_B, $id, $friendly), null);
check('mask isolation: update with another mask', structures_update($mysql, MASK_B, $id, ['state' => 'online'], 'X'), false);
check('mask isolation: gone with another mask', structures_set_gone($mysql, MASK_B, $id, 'destroyed', 'X'), false);

// A scan never changes owner / state / timer / note
structures_update($mysql, MASK_A, $id, ['state' => 'reinforced', 'timerKind' => 'armor', 'timerAt' => time() + 3600, 'note' => 'keep me'], 'Scout');
structures_apply_scan($mysql, MASK_A, SYSTEM, $parsed['structures'], 0, 'Scout 3');
$row = structures_get($mysql, MASK_A, $id, $friendly);
check('scan keeps state, timer and note', [$row['state'], $row['timerKind'], $row['note'], $row['timerSetBy']], ['reinforced', 'armor', 'keep me', 'Scout']);
check('timer end round-trips', abs($row['timerAt'] - (time() + 3600)) <= 2, true);

// Removed rows are restored by a scan, destroyed ones are not
check('remove', structures_set_gone($mysql, MASK_A, $id, 'removed', 'Scout'), true);
check('gone row is listed as gone', array_map(function ($r) { return $r['state']; }, structures_list($mysql, MASK_A, SYSTEM, $friendly)['gone']), ['removed']);
$res = structures_apply_scan($mysql, MASK_A, SYSTEM, $parsed['structures'], 0, 'Scout');
check('scan restores a removed row', [$res['restored'], $res['added']], [1, 0]);
structures_set_gone($mysql, MASK_A, $id, 'destroyed', 'Scout');
$res = structures_apply_scan($mysql, MASK_A, SYSTEM, $parsed['structures'], 0, 'Scout');
check('scan does not restore a destroyed row (a new row is added)', [$res['restored'], $res['added']], [0, 1]);
check('restore from the panel', structures_set_gone($mysql, MASK_A, $id, 'restore', 'Scout'), true);

// Limit of 200 live rows
$many = [];
for ($i = 0; $i < 210; $i++) $many[] = [33474, 'Mobile Depot', 'deployable', 'Depot ' . $i, null, '', 'Depot ' . $i, false];
$res = structures_apply_scan($mysql, MASK_A, SYSTEM + 1, $many, 0, 'Scout');
check('200 live rows per system', [$res['added'], $res['skipped']], [200, 10]);

// Owner: cache only, exact and case-insensitive, ambiguous tickers give choices
$mysql->exec("INSERT INTO fork_pilot_entities (id, kind, name, ticker, status, requestedAt, wantedAt, fetchedAt) VALUES
    (2100000001, 'corporation', 'Zzs Home Corp', 'ZZH', 'done', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    (2100000002, 'corporation', 'Zzs Hostile Corp', 'ZZX', 'done', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP()),
    (2100000003, 'alliance', 'Zzs Hostile Alliance', 'ZZX', 'done', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())");
check('owner by ticker, case-insensitive', structures_owner_lookup($mysql, 'zzh')['match'] ?? null, [2100000001, 'corporation', 'Zzs Home Corp', 'ZZH']);
check('owner by name', structures_owner_lookup($mysql, 'zzs hostile corp')['match'][0] ?? null, 2100000002);
check('colliding ticker gives choices', array_map(function ($c) { return $c[0]; }, structures_owner_lookup($mysql, 'ZZX')['choices'] ?? []), [2100000002, 2100000003]);
check('unknown owner', structures_owner_lookup($mysql, 'Nobody Corp'), []);
[$changes, $error, $choices] = structures_changes($mysql, ['owner' => 'ZZH'], $now);
check('changes: owner resolved', [$changes['ownerID'], $changes['ownerTicker'], $error], [2100000001, 'ZZH', null]);
[$changes] = structures_changes($mysql, ['owner' => 'Some Unknown Corp'], $now);
check('changes: unresolved owner keeps the text', [$changes['ownerID'], $changes['ownerText']], [null, 'Some Unknown Corp']);
[, , $choices] = structures_changes($mysql, ['owner' => 'ZZX'], $now);
check('changes: ambiguous owner returns choices, saves nothing', count($choices), 2);
[$changes] = structures_changes($mysql, ['ownerID' => '2100000003', 'ownerType' => 'alliance'], $now);
check('changes: picked choice', $changes['ownerName'], 'Zzs Hostile Alliance');
[$changes] = structures_changes($mysql, ['timerKind' => 'hull', 'timerAt' => gmdate('Y-m-d H:i', $now + 3600)], $now);
check('changes: a hull timer sets state reinforced', [$changes['state'], $changes['timerKind']], ['reinforced', 'hull']);
[, $error] = structures_changes($mysql, ['timerKind' => 'hull', 'timerAt' => gmdate('Y-m-d H:i', $now + 3 * 2592000)], $now);
check('changes: timer too far ahead is refused', $error !== null, true);
[, $error] = structures_changes($mysql, ['state' => 'nonsense'], $now);
check('changes: bad state is refused', $error, 'Invalid state');
[$changes] = structures_changes($mysql, ['note' => str_repeat('n', 600)], $now);
check('changes: note is capped', mb_strlen($changes['note']), STRUCTURES_NOTE_MAX);

// Ours / hostile
structures_update($mysql, MASK_A, $id, structures_changes($mysql, ['owner' => 'ZZH'], $now)[0], 'Scout');
check('owner in the friendly corporations is ours', structures_get($mysql, MASK_A, $id, $friendly)['side'], 'ours');
structures_update($mysql, MASK_A, $id, structures_changes($mysql, ['owner' => 'zzs hostile corp'], $now)[0], 'Scout');
check('another resolved owner is hostile', structures_get($mysql, MASK_A, $id, $friendly)['side'], 'hostile');
structures_update($mysql, MASK_A, $id, structures_changes($mysql, ['owner' => ''], $now)[0], 'Scout');
check('no owner is neutral', structures_get($mysql, MASK_A, $id, $friendly)['side'], 'unknown');

// Prune: deployables not seen for 7 days go, Upwell and POS never, gone rows after 30 days
$twin = (int) $mysql->query("SELECT id FROM fork_structures WHERE maskID = " . MASK_A . " AND systemID = " . SYSTEM . " AND kind = 'upwell' AND id <> $id")->fetchColumn();
structures_set_gone($mysql, MASK_A, $twin, 'destroyed', 'Scout');
$mysql->exec("UPDATE fork_structures SET lastSeenAt = UTC_TIMESTAMP() - INTERVAL 40 DAY WHERE maskID = " . MASK_A . " AND systemID = " . SYSTEM);
$mysql->exec("UPDATE fork_structures SET goneAt = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE maskID = " . MASK_A . " AND systemID = " . SYSTEM . " AND state = 'destroyed'");
$before = (int) $mysql->query('SELECT COUNT(*) FROM fork_structures WHERE maskID = ' . MASK_A . ' AND systemID = ' . SYSTEM)->fetchColumn();
structures_prune($mysql);
$left = $mysql->query('SELECT kind, state FROM fork_structures WHERE maskID = ' . MASK_A . ' AND systemID = ' . SYSTEM . ' ORDER BY kind, id')->fetchAll(PDO::FETCH_ASSOC);
check('prune: Upwell and POS stay however old, deployables and old gone rows go', array_map(function ($r) { return $r['kind']; }, $left), ['starbase', 'upwell']);
check('prune: removed some rows', $before > count($left), true);

check('rate limit lets 20 writes through, then stops', (function ($mysql) {
    $ok = 0;
    for ($i = 0; $i < 25; $i++) if (structures_rate_ok($mysql, 900011)) $ok++;
    return $ok;
})($mysql), STRUCTURES_RATE_PER_MIN);

cleanup($mysql);
fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
