<?php
// Fork-owned: tests of public/zkill_kill.php (Smart notes kill cards) against the dev database: auth, ID validation
// and limits, stored kill vs queue, queue caps, names, the friendly side. Uses kill / name IDs and users no real data
// has and removes its rows afterwards. Never calls zKillboard or ESI (the endpoint only reads and queues).
//   docker compose -f docker-compose.dev.yml exec -T app php zkill/tests/zkill_kill_endpoint_test.php
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

const BASE = 990000000000;        // test IDs: BASE .. BASE + 99999
const KILL = BASE + 1;            // stored below
const MISSING = BASE + 2;         // not stored: queued
const TYPE = 4290000000;        // test ship type IDs (the type columns are 32-bit): TYPE .. TYPE + 999
const ENTITY = 2147483000;        // test character / corporation IDs (32-bit, top of the range): ENTITY .. ENTITY + 647
const USER = 900101;
const SESSION = ['userID' => USER, 'mask' => '98000001.2', 'corporationID' => 98000001, 'allianceID' => 99000001];

/** Run the endpoint in a separate PHP process. @return [status, decoded body] */
function call($params, $session = SESSION, $feed = true, $method = 'GET') {
    $request = ['script' => 'zkill_kill.php', 'method' => $method, 'get' => $params, 'session' => $session];
    // The feed setting decides whether missing kills are queued (nobody drains the queue while it is off). Only the
    // endpoint process sees this; no worker runs here.
    $env = getenv();
    $env['ZKILL_FEED_ENABLED'] = $feed ? 'true' : 'false';
    $proc = proc_open(['php', __DIR__ . '/endpoint_runner.php'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    fwrite($pipes[0], json_encode($request));
    fclose($pipes[0]);
    $body = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    proc_close($proc);
    $status = preg_match('/STATUS (\d+)/', $err, $m) ? (int) $m[1] : 0;
    return [$status, json_decode($body, true)];
}

function cleanup(PDO $mysql) {
    $range = 'BETWEEN ' . BASE . ' AND ' . (BASE + 99999);
    $mysql->exec("DELETE FROM zkill_killmails WHERE killID $range");
    $mysql->exec("DELETE FROM zkill_kill_lookup WHERE killID $range");
    $mysql->exec("DELETE FROM zkill_names WHERE id $range OR id BETWEEN " . TYPE . " AND " . (TYPE + 999) . " OR id BETWEEN " . ENTITY . " AND " . (ENTITY + 647));
}

/** A stored kill (older than the retention, as a looked-up kill would be) with a victim in our alliance, and names */
function seed(PDO $mysql) {
    zk_store_row($mysql, [
        'killID' => KILL, 'systemID' => 31002012, 'killTime' => '2026-09-01 21:13:05', 'hash' => 'ab12',
        'victimCharacterID' => BASE + 101, 'victimCorporationID' => BASE + 102, 'victimAllianceID' => 99000001, 'victimShipTypeID' => TYPE + 103,
        'finalBlowCharacterID' => BASE + 104, 'finalBlowCorporationID' => BASE + 105, 'finalBlowAllianceID' => null, 'finalBlowShipTypeID' => TYPE + 106,
        'attackerCount' => 7, 'attackerTotal' => 9, 'totalValue' => 1234567890.5, 'npc' => 0, 'solo' => 0, 'awox' => 0,
    ], 'lookup');
    $names = $mysql->prepare('INSERT INTO zkill_names (id, name, category, requestedAt, resolvedAt) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())');
    $names->execute([BASE + 101, '<img src=x onerror=alert(1)>', 'character']);
    $names->execute([BASE + 102, 'Hole Dwellers', 'corporation']);
    $names->execute([TYPE + 103, 'Loki', 'inventory_type']);
    $names->execute([ENTITY + 1, 'Some Corp', 'corporation']);
}

$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
zk_ensure_schema($mysql);
cleanup($mysql);
seed($mysql);

// --- Access and validation ---
check('no session: 403', call(['ids' => (string) KILL], [])[0], 403);
check('no mask: 403', call(['ids' => (string) KILL], ['userID' => USER])[0], 403);
check('POST: 405', call(['ids' => (string) KILL], SESSION, true, 'POST')[0], 405);
check('nothing asked: 400', call([])[0], 400);
check('not a number: 400', call(['ids' => '12,abc'])[0], 400);
check('negative: 400', call(['ids' => '-5'])[0], 400);
check('too long an ID: 400', call(['ids' => '1234567890123'])[0], 400);
check('zero: 400', call(['ids' => '0'])[0], 400);
check('array parameter: 400', call(['ids' => ['1']])[0], 400);
check('21 IDs: 400', call(['ids' => implode(',', range(BASE + 1, BASE + 21))])[0], 400);
check('21 names: 400', call(['names' => implode(',', range(ENTITY + 1, ENTITY + 21))])[0], 400);
check('names above 32 bits: 400', call(['names' => '2147483648'])[0], 400);
check('20 IDs (and duplicates, spaces, empty parts): 200', call(['ids' => implode(', ', range(BASE + 1, BASE + 20)) . ',,' . (BASE + 1)])[0], 200);
cleanup($mysql);
seed($mysql);

// --- Stored kill: card data from the row, names from the cache ---
[$status, $body] = call(['ids' => KILL . ',' . MISSING, 'names' => (string) (ENTITY + 1)]);
check('ok: 200', $status, 200);
$card = $body['kills'][(string) KILL];
check('ok: card', [$card['status'], $card['killID'], $card['killTime'], $card['systemID'], $card['attackers'], $card['pilots'], $card['value']],
    ['ok', KILL, '2026-09-01T21:13:05Z', 31002012, 9, 7, 1234567890.5]);
check('ok: victim and final blow', [$card['victim'], $card['finalBlow']['shipTypeID']],
    [['characterID' => BASE + 101, 'corporationID' => BASE + 102, 'allianceID' => 99000001, 'shipTypeID' => TYPE + 103], TYPE + 106]);
check('ok: victim in our alliance is a loss', $card['side'], 'loss');
check('names: hostile name comes back as data', $body['names'][(string) (BASE + 101)], '<img src=x onerror=alert(1)>');
check('names: corp, ship and the asked entity', [$body['names'][(string) (BASE + 102)], $body['names'][(string) (TYPE + 103)], $body['names'][(string) (ENTITY + 1)]],
    ['Hole Dwellers', 'Loki', 'Some Corp']);
check('names: unknown ones are queued, pending while the feed runs', [$body['namesPending'],
    (int) $mysql->query('SELECT COUNT(*) FROM zkill_names WHERE id = ' . (TYPE + 106) . ' AND name IS NULL')->fetchColumn()], [true, 1]);
check('missing kill: queued', $body['kills'][(string) MISSING], ['status' => 'queued']);
$row = $mysql->query('SELECT status, requestedBy FROM zkill_kill_lookup WHERE killID = ' . MISSING)->fetch(PDO::FETCH_ASSOC);
check('missing kill: queue row for this user', [$row['status'], (int) $row['requestedBy']], ['queued', USER]);
check('asking again: still one row', [call(['ids' => (string) MISSING])[1]['kills'][(string) MISSING]['status'],
    (int) $mysql->query('SELECT COUNT(*) FROM zkill_kill_lookup WHERE killID = ' . MISSING)->fetchColumn()], ['queued', 1]);

// Asked-for names are only queued while the name queue is short
$names = $mysql->prepare('INSERT INTO zkill_names (id, requestedAt) VALUES (?, UTC_TIMESTAMP())');
$backlog = (int) $mysql->query('SELECT COUNT(*) FROM zkill_names WHERE name IS NULL')->fetchColumn();
$mysql->beginTransaction();
for ($i = 0; $backlog + $i < 200; $i++) $names->execute([TYPE + 200 + $i]);
$mysql->commit();
[$status, $body] = call(['names' => (string) (ENTITY + 2)]);
check('name backlog: not queued, not pending', [$status, $body['namesPending'],
    (int) $mysql->query('SELECT COUNT(*) FROM zkill_names WHERE id = ' . (ENTITY + 2))->fetchColumn()], [200, false, 0]);
$mysql->exec('DELETE FROM zkill_names WHERE id BETWEEN ' . (TYPE + 200) . ' AND ' . (TYPE + 999));
[$status, $body] = call(['names' => (string) (ENTITY + 2)]);
check('name backlog cleared: queued', [$body['namesPending'], (int) $mysql->query('SELECT COUNT(*) FROM zkill_names WHERE id = ' . (ENTITY + 2))->fetchColumn()], [true, 1]);

// Side: a kill by our corporation (final blow), someone else's kill, the mask owner
check('side: final blow by our corp is a kill', call(['ids' => (string) KILL], ['userID' => USER, 'mask' => '1.1', 'corporationID' => BASE + 105])[1]['kills'][(string) KILL]['side'], 'kill');
check('side: neither', call(['ids' => (string) KILL], ['userID' => USER, 'mask' => '1.1', 'corporationID' => 5])[1]['kills'][(string) KILL]['side'], null);
check('side: corporation mask owner', call(['ids' => (string) KILL], ['userID' => USER, 'mask' => (BASE + 102) . '.2'])[1]['kills'][(string) KILL]['side'], 'loss');

// Feed off: nothing queued, the browser shows the plain link
[$status, $body] = call(['ids' => (string) (BASE + 3)], SESSION, false);
check('feed off: unavailable', [$body['kills'][(string) (BASE + 3)], $body['namesPending']], [['status' => 'unavailable'], false]);
check('feed off: no queue row', (int) $mysql->query('SELECT COUNT(*) FROM zkill_kill_lookup WHERE killID = ' . (BASE + 3))->fetchColumn(), 0);
check('feed off: stored kills still answer', call(['ids' => (string) KILL], SESSION, false)[1]['kills'][(string) KILL]['status'], 'ok');

// --- Caps ---
$insert = $mysql->prepare("INSERT INTO zkill_kill_lookup (killID, status, requestedBy, requestedAt) VALUES (?, 'queued', ?, UTC_TIMESTAMP())");
$mysql->beginTransaction();
for ($i = 0; $i < ZK_LOOKUP_MAX_PER_USER; $i++) $insert->execute([BASE + 10000 + $i, USER + 1]);
$mysql->commit();
check('cap: user at the cap gets full', call(['ids' => (string) (BASE + 4)], ['userID' => USER + 1, 'mask' => '1.1'])[1]['kills'][(string) (BASE + 4)], ['status' => 'full']);
check('cap: another user is still queued', call(['ids' => (string) (BASE + 5)])[1]['kills'][(string) (BASE + 5)], ['status' => 'queued']);
$queued = (int) $mysql->query("SELECT COUNT(*) FROM zkill_kill_lookup WHERE status IN ('queued', 'running')")->fetchColumn();
$mysql->beginTransaction();
for ($i = 0; $queued + $i < ZK_LOOKUP_MAX_QUEUED; $i++) $insert->execute([BASE + 20000 + $i, 900200 + ($i % 50)]);
$mysql->commit();
check('cap: overall cap', call(['ids' => (string) (BASE + 6)], ['userID' => USER + 2, 'mask' => '1.1'])[1]['kills'][(string) (BASE + 6)], ['status' => 'full']);

cleanup($mysql);
echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
