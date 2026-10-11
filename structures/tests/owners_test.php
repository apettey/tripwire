<?php
// Fork-owned: tests of the smart input of the Structures feature (spec phase 4): the owner lookups the zKillboard worker
// resolves (structures/owners.inc.php) with ESI replaced by a fake transport (zk_http_transport: nothing leaves the
// container, anything unexpected fails), and the hints from stored kills (structures_suggestions). Against the dev database
// with a mask no real user has and IDs / names "Zzo ..."; the rows are removed afterwards.
//   docker compose -f docker-compose.dev.yml exec -T app php structures/tests/owners_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../structures.inc.php');
require_once(__DIR__ . '/../owners.inc.php');
require_once(__DIR__ . '/../../zkill/zkill.inc.php');

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

// Every outgoing request goes through this fake
$calls = [];
$handler = function ($method, $url, $body) { return [599, 'unexpected request', []]; };
zk_http_transport(function ($method, $url, $body) use (&$calls, &$handler) {
    $calls[] = [$method, $url, $body];
    return $handler($method, $url, $body);
});
zk_log_sink(function ($message) { });
function limiter_reset() {
    $state = &zk_http_state();
    $state = [];
}

const MASK_A = '999999995.1';
const SYSTEM = 31001240;
const GHOST = 2100000010;      // a corporation ESI knows by name
const VICTIM = 2100000011;     // lost a structure in the system
const KILLS = [9990000001, 9990000002, 9990000003];

function cleanup($db) {
    $db->exec('DELETE FROM fork_structures WHERE maskID = ' . MASK_A);
    $db->exec("DELETE FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %'");
    $db->exec('DELETE FROM fork_pilot_entities WHERE id IN (' . GHOST . ', ' . VICTIM . ', 2100000020, 2100000021)');
    $db->exec('DELETE FROM zkill_killmails WHERE killID IN (' . implode(',', KILLS) . ')');
}
structures_schema($mysql);
structures_owner_schema($mysql);
intel_pilots_schema($mysql);
zk_ensure_schema($mysql);
cleanup($mysql);

// --- queueing (web side) ---
check('queue: a short text is not worth asking', structures_owner_queue($mysql, 'ab'), false);
check('queue: a name is queued', structures_owner_queue($mysql, 'Zzo Ghost Corp'), true);
check('queue: the same name in another case is the same row', [structures_owner_queue($mysql, 'zzo ghost corp'), (int) $mysql->query("SELECT COUNT(*) FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo Ghost%'")->fetchColumn()], [true, 1]);
check('queue: changes with a resolved owner or none queue nothing', [structures_queue_owner_text($mysql, ['ownerID' => 5, 'ownerText' => null]), structures_queue_owner_text($mysql, ['note' => 'x']), structures_queue_owner_text($mysql, ['ownerID' => null, 'ownerText' => ''])], [false, false, false]);
check('queue: unresolved text from a request is queued', [structures_queue_owner_text($mysql, ['ownerID' => null, 'ownerText' => 'Zzo Nobody Inc']), (int) $mysql->query("SELECT COUNT(*) FROM fork_structure_owner_lookups WHERE name = 'Zzo Nobody Inc'")->fetchColumn()], [true, 1]);

// Two unresolved structures typed by hand (one of them with other letter case) and one that stays unknown
$scan = structures_parse_scan("35832\tJ163702 - One\tAstrahus\t1 km\n35833\tJ163702 - Two\tFortizar\t2 km\n35835\tJ163702 - Three\tAthanor\t3 km", 'J163702');
structures_apply_scan($mysql, MASK_A, SYSTEM, $scan['structures'], 0, 'Scout');
$ids = [];
foreach (structures_list($mysql, MASK_A, SYSTEM, ['corporations' => [], 'alliances' => []])['structures'] as $r) $ids[$r['typeName']] = $r['id'];
$mysql->exec("UPDATE fork_structures SET ownerText = 'zzo ghost corp' WHERE id = " . $ids['Astrahus']);
$mysql->exec("UPDATE fork_structures SET ownerText = 'Zzo Ghost Corp' WHERE id = " . $ids['Fortizar']);
$mysql->exec("UPDATE fork_structures SET ownerText = 'Zzo Nobody Inc' WHERE id = " . $ids['Athanor']);

// --- the worker pass: ESI /universe/ids, then the entity queue, then the rows ---
limiter_reset();
$handler = function ($method, $url, $body) {
    $names = json_decode($body, true);
    $corporations = [];
    foreach ($names as $n) if (strcasecmp($n, 'Zzo Ghost Corp') === 0) $corporations[] = ['id' => GHOST, 'name' => 'Zzo Ghost Corp'];
    return [200, json_encode(['corporations' => $corporations]), []];
};
$line = structures_owner_run($mysql);
check('run: one POST /universe/ids with the queued names', [count($calls), $calls[0][0], $calls[0][1], $calls[0][2] !== null], [1, 'POST', ZK_ESI_BASE . 'universe/ids', true]);
$sent = json_decode($calls[0][2], true);
sort($sent);
check('run: ... both names', $sent, ['Zzo Ghost Corp', 'Zzo Nobody Inc']);
check('run: the log line', $line, 'structure owners: 1 names resolved, 1 unknown, 2 rows updated');
$lookups = $mysql->query("SELECT name, status, entityID, entityType FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %' ORDER BY name")->fetchAll(PDO::FETCH_NUM);
check('run: lookup answers', $lookups, [['Zzo Ghost Corp', 'done', GHOST, 'corporation'], ['Zzo Nobody Inc', 'none', null, null]]);
$rows = $mysql->query('SELECT typeName, ownerID, ownerType, ownerName, ownerText, ownerTicker FROM fork_structures WHERE maskID = ' . MASK_A . ' ORDER BY typeName')->fetchAll(PDO::FETCH_NUM);
check('run: the typed owners are resolved (any letter case), the unknown one stays text',
    $rows, [['Astrahus', GHOST, 'corporation', 'Zzo Ghost Corp', null, null], ['Athanor', null, null, null, 'Zzo Nobody Inc', null], ['Fortizar', GHOST, 'corporation', 'Zzo Ghost Corp', null, null]]);
check('run: the entity is queued for its name and ticker', $mysql->query('SELECT status FROM fork_pilot_entities WHERE id = ' . GHOST)->fetchColumn(), 'queued');
// intel_entities_step of the same worker fetches the ticker; then the next pass fills it in
$mysql->exec("UPDATE fork_pilot_entities SET name = 'Zzo Ghost Corp', ticker = 'ZZG', status = 'done', fetchedAt = UTC_TIMESTAMP() WHERE id = " . GHOST);
limiter_reset();
$calls = [];
$line = structures_owner_run($mysql, 1, 0);
check('run: the ticker is filled from the entity cache, no request', [$line, count($calls), $mysql->query('SELECT COUNT(DISTINCT ownerTicker) FROM fork_structures WHERE ownerTicker = \'ZZG\' AND maskID = ' . MASK_A)->fetchColumn()], ['structure owners: 0 names resolved, 0 unknown, 2 rows updated', 0, 1]);
check('run: nothing left to do', structures_owner_run($mysql, 1, 0), null);
check('run: answers are not applied again within the apply interval', structures_owner_run($mysql), null);
check('run: a name ESI did not know is not asked again by a retype', [structures_owner_queue($mysql, 'Zzo Nobody Inc'), $mysql->query("SELECT status FROM fork_structure_owner_lookups WHERE name = 'Zzo Nobody Inc'")->fetchColumn()], [true, 'none']);

// ESI failures: 5xx / rate limit keep the queue; a rejected batch is split (tiers) and only a name rejected on its own fails
$mysql->exec("DELETE FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %'");
structures_owner_queue($mysql, 'Zzo Broken Corp');
$handler = function () { return [503, 'down', []]; };
limiter_reset();
check('failure: a 5xx leaves it queued', [structures_owner_run($mysql, 1, 0), $mysql->query("SELECT status, attempts FROM fork_structure_owner_lookups WHERE name = 'Zzo Broken Corp'")->fetch(PDO::FETCH_NUM)], [null, ['queued', 0]]);
$handler = function () { return [400, 'bad', []]; };
limiter_reset();
structures_owner_run($mysql, 1, 0);
check('failure: a name rejected on its own is failed', $mysql->query("SELECT status FROM fork_structure_owner_lookups WHERE name = 'Zzo Broken Corp'")->fetchColumn(), 'failed');

// One bad name spoils its batch: ESI answers 400 to any request that contains it
$mysql->exec("DELETE FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %'");
foreach (['Zzo Good One', 'Zzo Bad One', 'Zzo Good Two'] as $n) structures_owner_queue($mysql, $n);
$good = ['zzo good one' => 2100000020, 'zzo good two' => 2100000021];
$handler = function ($method, $url, $body) use ($good) {
    $names = json_decode($body, true);
    foreach ($names as $n) if (stripos($n, 'Bad One') !== false) return [400, 'bad name', []];
    $corporations = [];
    foreach ($names as $n) $corporations[] = ['id' => $good[strtolower($n)], 'name' => $n];
    return [200, json_encode(['corporations' => $corporations]), []];
};
$calls = [];
for ($i = 0; $i < 5; $i++) { limiter_reset(); structures_owner_run($mysql, 1, 0); }
check('split: the batch of three is rejected, then the small batch, then one by one: the good names resolve, only the bad one fails',
    $mysql->query("SELECT name, status FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %' ORDER BY name")->fetchAll(PDO::FETCH_NUM),
    [['Zzo Bad One', 'failed'], ['Zzo Good One', 'done'], ['Zzo Good Two', 'done']]);
check('split: five requests in all (3, 3, then singles)', array_map(function ($c) { return count(json_decode($c[2], true)); }, $calls), [3, 3, 1, 1, 1]);
$handler = function ($method, $url, $body) { return [599, 'unexpected request', []]; };

// --- the queue rules ---
$mysql->exec("DELETE FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %' OR maskID IN (999999995.1, 999999995.3)");
check('queue: a ticker is not asked of ESI (the cache by ticker is tried first)', [structures_owner_queue($mysql, 'HSTL', MASK_A), structures_owner_queue($mysql, '[ABC]', MASK_A), structures_owner_queue($mysql, 'Zzo Real Name', MASK_A)], [false, false, true]);
$mysql->exec("UPDATE fork_structure_owner_lookups SET attempts = 2, requestedAt = '2020-01-01 00:00:00' WHERE name = 'Zzo Real Name'");
structures_owner_queue($mysql, 'zzo real name', MASK_A);
check('queue: a name already queued is left as it is (attempts and time are not reset)', $mysql->query("SELECT attempts, requestedAt FROM fork_structure_owner_lookups WHERE name = 'Zzo Real Name'")->fetch(PDO::FETCH_NUM), [2, '2020-01-01 00:00:00']);
$ins = $mysql->prepare("INSERT INTO fork_structure_owner_lookups (name, maskID, status, requestedAt) VALUES (?, ?, 'queued', UTC_TIMESTAMP())");
for ($i = 0; $i < STRUCTURES_OWNER_QUEUE_MAX - 2; $i++) $ins->execute(['Zzo Filler ' . $i, MASK_A]);
check('queue: up to the cap per mask', structures_owner_queue($mysql, 'Zzo Last One', MASK_A), true);
check('queue: over the cap the name is refused (and logged); another mask can still queue', [structures_owner_queue($mysql, 'Zzo One Too Many', MASK_A), structures_owner_queue($mysql, 'Zzo One Too Many', '999999995.3')], [false, true]);
$mysql->exec("DELETE FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %'");

// A name ESI already answered: typing it on another structure applies the answer at once (no request, this mask's rows only)
$mysql->exec("INSERT INTO fork_structure_owner_lookups (name, maskID, status, entityID, entityType, entityName, requestedAt) VALUES ('Zzo Known Corp', 999999995.1, 'done', 2100000020, 'corporation', 'Zzo Known Corp', UTC_TIMESTAMP())");
$mysql->exec('DELETE FROM fork_pilot_entities WHERE id = 2100000020');
$mysql->exec("INSERT INTO fork_pilot_entities (id, kind, name, ticker, status, requestedAt, wantedAt, fetchedAt) VALUES (2100000020, 'corporation', 'Zzo Known Corp', 'ZZK', 'done', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())");
structures_apply_scan($mysql, MASK_A, SYSTEM, structures_parse_scan("35835\tJ163702 - New\tAthanor\t1 km", 'J163702')['structures'], 0, 'Scout');
structures_apply_scan($mysql, '999999995.3', SYSTEM, structures_parse_scan("35835\tJ163702 - Other\tAthanor\t1 km", 'J163702')['structures'], 0, 'Scout');
$mysql->exec("UPDATE fork_structures SET ownerText = 'zzo known corp' WHERE name IN ('J163702 - New', 'J163702 - Other')");
$calls = [];
check('queue: an answered name is applied to the asking mask at once', [structures_queue_owner_text($mysql, ['ownerID' => null, 'ownerText' => 'zzo known corp'], MASK_A), count($calls)], [true, 0]);
check('... owner, type, name and the ticker from the cache; the other mask keeps its text', $mysql->query("SELECT maskID, ownerID, ownerType, ownerName, ownerTicker, ownerText FROM fork_structures WHERE name IN ('J163702 - New', 'J163702 - Other') ORDER BY maskID")->fetchAll(PDO::FETCH_NUM),
    [['999999995.1', 2100000020, 'corporation', 'Zzo Known Corp', 'ZZK', null], ['999999995.3', null, null, null, null, 'zzo known corp']]);
$mysql->exec("DELETE FROM fork_structures WHERE maskID = 999999995.3");
$mysql->exec("DELETE FROM fork_structure_owner_lookups WHERE name LIKE 'Zzo %'");
$mysql->exec('DELETE FROM fork_structures WHERE maskID = ' . MASK_A);

// --- hints from stored kills ---
cleanup($mysql);
$scan = structures_parse_scan("35832\tJ163702 - One\tAstrahus\t1 km\n35832\tJ163702 - Owned\tAstrahus\t2 km\n35833\tJ163702 - Fort\tFortizar\t3 km", 'J163702');
structures_apply_scan($mysql, MASK_A, SYSTEM, $scan['structures'], 0, 'Scout');
$friendly = ['corporations' => [], 'alliances' => []];
$byName = [];
foreach (structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'] as $r) $byName[$r['name']] = $r['id'];
$now = time();
$mysql->exec('UPDATE fork_structures SET firstSeenAt = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE maskID = ' . MASK_A);
$mysql->exec("INSERT INTO fork_pilot_entities (id, kind, name, ticker, status, requestedAt, wantedAt, fetchedAt) VALUES (" . VICTIM . ", 'corporation', 'Zzo Victim Corp', 'ZZV', 'done', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())");
$kill = function ($killID, $typeID, $corp, $secondsAgo) use ($mysql) {
    $mysql->prepare('INSERT INTO zkill_killmails (killID, systemID, killTime, receivedAt, victimShipTypeID, victimCorporationID) VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, ?)')
        ->execute([$killID, SYSTEM, gmdate('Y-m-d H:i:s', time() - $secondsAgo), $typeID, $corp]);
};
$kill(KILLS[0], 35832, VICTIM, 3600);            // an Astrahus of VICTIM died here an hour ago, after the rows were first seen
$kill(KILLS[1], 35832, VICTIM, 4 * 86400);       // and another 4 days ago (before: still a hint for the owner, not for "destroyed")
$kill(KILLS[2], 35835, VICTIM, 600);             // an Athanor: no row of that type here
$live = structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'];
$mysql->exec("UPDATE fork_structures SET ownerID = 2100000099, ownerType = 'corporation', ownerName = 'Someone Else', ownerTicker = 'SOME' WHERE id = " . $byName['J163702 - Owned']);
$live = structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'];
$s = structures_suggestions($mysql, SYSTEM, $live, $now);
check('hints: only the ownerless Astrahus gets any', array_keys($s), [$byName['J163702 - One']]);
check('hints: an ownerless Astrahus: destroyed? (the newer kill) and the likeliest owner with its cached name', [$s[$byName['J163702 - One']]['destroyed'][0], $s[$byName['J163702 - One']]['owner']],
    [KILLS[0], [[VICTIM, 'corporation', 'Zzo Victim Corp', 'ZZV', 2]]]);
check('hints: an Astrahus owned by someone else: no destroyed? (the victim is another corporation) and no owner hint', $s[$byName['J163702 - Owned']] ?? 'none', 'none');
$mysql->exec("UPDATE fork_structures SET ownerID = " . VICTIM . ", ownerType = 'corporation', ownerName = 'Zzo Victim Corp', ownerTicker = 'ZZV' WHERE id = " . $byName['J163702 - Owned']);
$s = structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now);
check('hints: an Astrahus owned by the victim: destroyed?, no owner hint', [$s[$byName['J163702 - Owned']]['destroyed'][0], isset($s[$byName['J163702 - Owned']]['owner'])], [KILLS[0], false]);
// An owner candidate the entity cache does not know yet is queued for the worker and not shown until it is known
$mysql->exec('DELETE FROM fork_pilot_entities WHERE id = ' . VICTIM);
$s = structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now);
check('hints: an unknown candidate is queued, not shown', [isset($s[$byName['J163702 - One']]['owner']), $mysql->query('SELECT status FROM fork_pilot_entities WHERE id = ' . VICTIM)->fetchColumn(), isset($s[$byName['J163702 - One']]['destroyed'])], [false, 'queued', false]);
check('hints: kills older than the window are ignored', structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now + 40 * 86400), []);
// A kill is offered to one structure only: three Athanors, one kill
$mysql->exec('DELETE FROM fork_structures WHERE maskID = ' . MASK_A);
$scan3 = structures_parse_scan("35835\tJ163702 - A1\tAthanor\t1 km\n35835\tJ163702 - A2\tAthanor\t2 km\n35835\tJ163702 - A3\tAthanor\t3 km", 'J163702');
structures_apply_scan($mysql, MASK_A, SYSTEM, $scan3['structures'], 0, 'Scout');
$mysql->exec('UPDATE fork_structures SET firstSeenAt = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE maskID = ' . MASK_A);
$a = [];
foreach (structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'] as $r) $a[$r['name']] = $r['id'];
$mysql->exec("UPDATE fork_structures SET lastSeenAt = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = " . $a['J163702 - A1']);   // seen an hour ago: the oldest sighting
$mysql->exec("UPDATE fork_structures SET lastSeenAt = UTC_TIMESTAMP() - INTERVAL 5 MINUTE WHERE id IN (" . $a['J163702 - A2'] . ', ' . $a['J163702 - A3'] . ')');
$mysql->exec('DELETE FROM zkill_killmails WHERE killID IN (' . implode(',', KILLS) . ')');
$kill(KILLS[2], 35835, VICTIM, 600);
$s = structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now);
$withDead = array_keys(array_filter($s, function ($h) { return isset($h['destroyed']); }));
check('hints: 3 Athanors and 1 kill: one structure gets "destroyed?", the one seen longest ago', $withDead, [$a['J163702 - A1']]);
$mysql->exec("UPDATE fork_structures SET ownerID = " . VICTIM . ", ownerType = 'corporation', ownerName = 'Zzo Victim Corp', ownerTicker = 'ZZV' WHERE id = " . $a['J163702 - A3']);
$s = structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now);
check('hints: ... but the one whose owner is the victim goes first', array_keys(array_filter($s, function ($h) { return isset($h['destroyed']); })), [$a['J163702 - A3']]);
$kill(KILLS[1], 35835, VICTIM, 300);
$s = structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now);
$dead = array_keys(array_filter($s, function ($h) { return isset($h['destroyed']); }));
sort($dead);
check('hints: two kills: two different structures', $dead, [min($a['J163702 - A1'], $a['J163702 - A3']), max($a['J163702 - A1'], $a['J163702 - A3'])]);

// Dismissing a hint hides it for the mask; the other hint stays; gone structures lose their dismissals on prune
check('dismiss: bad kind or key is refused', [structures_hint_dismiss($mysql, $a['J163702 - A3'], 'nope', '1', 'Scout'), structures_hint_dismiss($mysql, $a['J163702 - A3'], 'owner', 'x', 'Scout')], [false, false]);
$hint = $s[$a['J163702 - A3']]['destroyed'][0];
check('dismiss: stored', structures_hint_dismiss($mysql, $a['J163702 - A3'], 'destroyed', (string) $hint, 'Scout'), true);
$s = structures_suggestions($mysql, SYSTEM, structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'], $now);
$offered = array_map(function ($h) { return $h['destroyed'][0]; }, array_filter($s, function ($h) { return isset($h['destroyed']); }));
check('dismiss: dismissed on one structure of the type, the kill is dismissed for the whole system (it does not move to the next structure)', [in_array($hint, $offered, true), count($offered)], [false, 1]);
$mysql->exec('DELETE FROM fork_structure_hint_dismissed WHERE structureID IN (' . implode(',', array_values($a)) . ')');
structures_hint_dismiss($mysql, $byName['J163702 - One'] ?? 0, 'owner', (string) VICTIM, 'Scout');
check('prune: dismissals of structures that no longer exist are removed', [structures_prune($mysql) >= 0, (int) $mysql->query('SELECT COUNT(*) FROM fork_structure_hint_dismissed WHERE structureID = ' . (int) ($byName['J163702 - One'] ?? 0))->fetchColumn()], [true, 0]);

// An unknown candidate corporation is queued once: later polls write nothing
$mysql->exec('DELETE FROM fork_structures WHERE maskID = ' . MASK_A);
structures_apply_scan($mysql, MASK_A, SYSTEM, structures_parse_scan("35835\tJ163702 - Solo\tAthanor\t1 km", 'J163702')['structures'], 0, 'Scout');
$mysql->exec('UPDATE fork_structures SET firstSeenAt = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE maskID = ' . MASK_A);
$mysql->exec('DELETE FROM fork_pilot_entities WHERE id = ' . VICTIM);
$live = structures_list($mysql, MASK_A, SYSTEM, $friendly)['structures'];
structures_suggestions($mysql, SYSTEM, $live, $now);
$mysql->exec("UPDATE fork_pilot_entities SET requestedAt = '2020-01-01 00:00:00', wantedAt = '2020-01-01 00:00:00' WHERE id = " . VICTIM);
structures_suggestions($mysql, SYSTEM, $live, $now);
check('hints: a candidate already queued is not written again on later polls', $mysql->query('SELECT requestedAt FROM fork_pilot_entities WHERE id = ' . VICTIM)->fetchColumn(), '2020-01-01 00:00:00');
check('hints: no rows, no query', structures_suggestions($mysql, SYSTEM, [], $now), []);

cleanup($mysql);
fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
