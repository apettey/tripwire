<?php
// Fork-owned: tests of the single-kill lookup queue (zkill/lookup.php, Smart notes kill cards): the queue decisions,
// caps and the worker step against a fake zKillboard / ESI (zk_http_transport) on SQLite. No network, no MySQL.
//   docker compose -f docker-compose.dev.yml exec -T app php zkill/tests/lookup_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

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

// Nothing in this test may reach the network: every request goes through this fake
$calls = [];
$replies = [];   // URL => [status, body, headers]
zk_http_transport(function ($method, $url, $body) use (&$calls, &$replies) {
    $calls[] = $url;
    return $replies[$url] ?? [404, '{"error":"not stubbed"}', []];
});
$ready = function () {
    $state = &zk_http_state();
    unset($state['zkillboard.com'], $state['esi.evetech.net']);
};

// --- zk_lookup_valid_id ---
check('id: digits', zk_lookup_valid_id('131234567'), true);
check('id: int', zk_lookup_valid_id(131234567), true);
check('id: zero', zk_lookup_valid_id('0'), false);
check('id: negative', zk_lookup_valid_id(-5), false);
check('id: 13 digits', zk_lookup_valid_id('1234567890123'), false);
check('id: not digits', zk_lookup_valid_id('12a'), false);
check('id: sign', zk_lookup_valid_id('+12'), false);
check('id: empty', zk_lookup_valid_id(''), false);

// --- zk_lookup_decision ---
$now = 1000000;
check('decision: new', zk_lookup_decision(null, $now), ['action' => 'insert', 'status' => 'queued']);
check('decision: feed off', zk_lookup_decision(null, $now, false), ['action' => 'none', 'status' => 'unavailable']);
check('decision: queued', zk_lookup_decision(['status' => 'queued', 'attempts' => 0, 'attemptedAt' => null], $now), ['action' => 'none', 'status' => 'queued']);
check('decision: running', zk_lookup_decision(['status' => 'running', 'attempts' => 1, 'attemptedAt' => $now - 5], $now), ['action' => 'none', 'status' => 'queued']);
check('decision: done but pruned', zk_lookup_decision(['status' => 'done', 'attempts' => 1, 'attemptedAt' => $now - 86400], $now), ['action' => 'requeue', 'status' => 'queued']);
check('decision: failed recently', zk_lookup_decision(['status' => 'failed', 'attempts' => 1, 'attemptedAt' => $now - 60], $now), ['action' => 'none', 'status' => 'failed']);
check('decision: failed 10 min ago', zk_lookup_decision(['status' => 'failed', 'attempts' => 2, 'attemptedAt' => $now - ZK_LOOKUP_RETRY], $now), ['action' => 'requeue', 'status' => 'queued']);
check('decision: failed 3 times', zk_lookup_decision(['status' => 'failed', 'attempts' => 3, 'attemptedAt' => $now - 86400], $now), ['action' => 'none', 'status' => 'failed']);

// --- zk_lookup_admit ---
check('admit: room', zk_lookup_admit(10, 10, 5), true);
check('admit: user cap', zk_lookup_admit(10, ZK_LOOKUP_MAX_PER_USER, 5), false);
check('admit: global cap', zk_lookup_admit(ZK_LOOKUP_MAX_QUEUED, 0, 5), false);

// --- SQLite copies of the two tables (same columns as zkill/schema.php) ---
function lookup_db() {
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
    $db->exec("CREATE TABLE zkill_kill_lookup (killID INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        requestedBy INTEGER NOT NULL DEFAULT 0, requestedAt TEXT NOT NULL, attemptedAt TEXT NULL, error TEXT NOT NULL DEFAULT '')");
    $db->exec("CREATE TABLE zkill_killmails (id INTEGER PRIMARY KEY AUTOINCREMENT, killID INTEGER NOT NULL UNIQUE, systemID INTEGER NOT NULL,
        killTime TEXT NOT NULL, receivedAt TEXT, source TEXT NOT NULL DEFAULT 'feed', hash TEXT NOT NULL DEFAULT '',
        victimCharacterID INTEGER, victimCorporationID INTEGER, victimAllianceID INTEGER, victimShipTypeID INTEGER,
        finalBlowCharacterID INTEGER, finalBlowCorporationID INTEGER, finalBlowAllianceID INTEGER, finalBlowShipTypeID INTEGER,
        attackerCount INTEGER NOT NULL DEFAULT 0, attackerTotal INTEGER NOT NULL DEFAULT 0, totalValue REAL NOT NULL DEFAULT 0,
        npc INTEGER NOT NULL DEFAULT 0, solo INTEGER NOT NULL DEFAULT 0, awox INTEGER NOT NULL DEFAULT 0)");
    return $db;
}
function lookup_row(PDO $db, $killID) {
    $stmt = $db->prepare('SELECT * FROM zkill_kill_lookup WHERE killID = ?');
    $stmt->execute([$killID]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}
function lookup_add(PDO $db, $killID, array $fields = []) {
    $row = array_merge(['killID' => $killID, 'status' => 'queued', 'attempts' => 0, 'requestedBy' => 1,
        'requestedAt' => gmdate('Y-m-d H:i:s', time() - 60), 'attemptedAt' => null], $fields);
    $db->prepare('INSERT INTO zkill_kill_lookup (' . implode(', ', array_keys($row)) . ') VALUES (' . implode(', ', array_fill(0, count($row), '?')) . ')')
        ->execute(array_values($row));
}

$esi = [
    'killmail_id' => 131234567, 'killmail_time' => '2026-09-01T21:13:05Z', 'solar_system_id' => 31002012,
    'victim' => ['character_id' => 2116087385, 'corporation_id' => 98388312, 'alliance_id' => 99011223, 'ship_type_id' => 29990],
    'attackers' => [
        ['character_id' => 1, 'corporation_id' => 10, 'ship_type_id' => 17738, 'final_blow' => true],
        ['character_id' => 2, 'corporation_id' => 10, 'ship_type_id' => 11987],
        ['corporation_id' => 1000125, 'ship_type_id' => 3885],
    ],
];
$zkb = ['locationID' => 40000001, 'hash' => 'ab12cd34ef', 'totalValue' => 1234567890.5, 'npc' => false, 'solo' => false, 'awox' => false];
$zkillURL = 'https://zkillboard.com/api/killID/131234567/';
$esiURL = 'https://esi.evetech.net/killmails/131234567/ab12cd34ef/';

// --- zk_lookup_request: stored kills answer from the table, the rest is queued within the caps ---
$db = lookup_db();
zk_lookup_store($db, zk_killmail_row($esi + ['zkb' => $zkb]));
$result = zk_lookup_request($db, ['131234567', 131234568, 'junk', 131234568], 7, true);
check('request: stored kill is ok', [$result[131234567]['status'], (int) $result[131234567]['row']['systemID'], (int) $result[131234567]['row']['attackerTotal']], ['ok', 31002012, 3]);
check('request: missing kill is queued', $result[131234568], ['status' => 'queued']);
check('request: invalid IDs are ignored', array_keys($result), [131234567, 131234568]);
$row = lookup_row($db, 131234568);
check('request: queue row', [$row['status'], (int) $row['attempts'], (int) $row['requestedBy']], ['queued', 0, 7]);
check('request: asking again keeps one row', [zk_lookup_request($db, [131234568], 8, true)[131234568]['status'],
    (int) $db->query('SELECT COUNT(*) FROM zkill_kill_lookup')->fetchColumn(), (int) lookup_row($db, 131234568)['requestedBy']], ['queued', 1, 7]);
check('request: feed off queues nothing', [zk_lookup_request($db, [131234569], 7, false)[131234569]['status'], lookup_row($db, 131234569)], ['unavailable', false]);

// Failed: retried after the cooldown (attempts kept), not before, never after 3 attempts
lookup_add($db, 500, ['status' => 'failed', 'attempts' => 1, 'attemptedAt' => gmdate('Y-m-d H:i:s', time() - 60)]);
lookup_add($db, 501, ['status' => 'failed', 'attempts' => 2, 'attemptedAt' => gmdate('Y-m-d H:i:s', time() - ZK_LOOKUP_RETRY - 5)]);
lookup_add($db, 502, ['status' => 'failed', 'attempts' => 3, 'attemptedAt' => gmdate('Y-m-d H:i:s', time() - 86400)]);
lookup_add($db, 503, ['status' => 'done', 'attempts' => 1, 'attemptedAt' => gmdate('Y-m-d H:i:s', time() - 86400)]);
$result = zk_lookup_request($db, [500, 501, 502, 503], 7, true);
check('request: failed recently', $result[500]['status'], 'failed');
check('request: failed long ago is queued again', [$result[501]['status'], lookup_row($db, 501)['status'], (int) lookup_row($db, 501)['attempts']], ['queued', 'queued', 2]);
check('request: failed 3 times stays failed', [$result[502]['status'], lookup_row($db, 502)['status']], ['failed', 'failed']);
check('request: done but pruned starts over', [$result[503]['status'], lookup_row($db, 503)['status'], (int) lookup_row($db, 503)['attempts']], ['queued', 'queued', 0]);

// Caps: per user and overall
$db = lookup_db();
for ($i = 1; $i <= ZK_LOOKUP_MAX_PER_USER; $i++) lookup_add($db, 1000 + $i, ['requestedBy' => 9]);
check('cap: user at the cap gets full', zk_lookup_request($db, [5000], 9, true)[5000], ['status' => 'full']);
check('cap: nothing queued for them', lookup_row($db, 5000), false);
check('cap: another user still gets in', zk_lookup_request($db, [5001], 10, true)[5001], ['status' => 'queued']);
$db->exec("UPDATE zkill_kill_lookup SET status = 'done' WHERE requestedBy = 9");
check('cap: finished rows do not count', zk_lookup_request($db, [5000], 9, true)[5000], ['status' => 'queued']);
$db = lookup_db();
$db->beginTransaction();
for ($i = 1; $i <= ZK_LOOKUP_MAX_QUEUED; $i++) lookup_add($db, 10000 + $i, ['requestedBy' => 100 + ($i % 50)]);
$db->commit();
check('cap: overall cap', zk_lookup_request($db, [5002], 11, true)[5002], ['status' => 'full']);
// Several new kills in one request: the cap applies within the request too
$db = lookup_db();
for ($i = 1; $i < ZK_LOOKUP_MAX_PER_USER; $i++) lookup_add($db, 1000 + $i, ['requestedBy' => 9]);
$result = zk_lookup_request($db, [6000, 6001], 9, true);
check('cap: the last free slot goes to the first kill', [$result[6000]['status'], $result[6001]['status']], ['queued', 'full']);

// --- zk_lookup_run_one: the worker step ---
$db = lookup_db();
lookup_add($db, 131234567);
$replies = [
    $zkillURL => [200, json_encode([['killmail_id' => 131234567, 'zkb' => $zkb]]), []],
    $esiURL => [200, json_encode($esi), []],
];
$calls = [];
zk_http_pause('zkillboard.com', microtime(true) + 60);
check('run: nothing while zKillboard is paused', [zk_lookup_run_one($db), $calls, lookup_row($db, 131234567)['status']], [null, [], 'queued']);
$ready();
$line = zk_lookup_run_one($db);
check('run: zKillboard for the hash, then ESI for the killmail', $calls, [$zkillURL, $esiURL]);
check('run: log line', $line, 'kill lookup 131234567: stored (system 31002012, 2026-09-01 21:13:05)');
$row = lookup_row($db, 131234567);
check('run: done after one attempt', [$row['status'], (int) $row['attempts'], $row['error']], ['done', 1, '']);
$kill = $db->query('SELECT * FROM zkill_killmails WHERE killID = 131234567')->fetch(PDO::FETCH_ASSOC);
check('run: stored as lookup, even though it is older than the retention', [$kill['source'], (int) $kill['systemID'], $kill['killTime'], $kill['hash']],
    ['lookup', 31002012, '2026-09-01 21:13:05', 'ab12cd34ef']);
check('run: card fields', [(int) $kill['victimShipTypeID'], (int) $kill['finalBlowShipTypeID'], (int) $kill['attackerTotal'], (float) $kill['totalValue']],
    [29990, 17738, 3, 1234567890.5]);
$ready();
$calls = [];
check('run: nothing left to do', [zk_lookup_run_one($db), $calls], [null, []]);

// Already stored by the stream in the meantime: done, not stored twice
$db->exec("UPDATE zkill_kill_lookup SET status = 'queued' WHERE killID = 131234567");
$ready();
check('run: already stored', zk_lookup_run_one($db), 'kill lookup 131234567: already stored (system 31002012, 2026-09-01 21:13:05)');
check('run: still one killmail row', (int) $db->query('SELECT COUNT(*) FROM zkill_killmails')->fetchColumn(), 1);

// Failures: unknown kill, HTTP errors, bad hash, ESI error
$db = lookup_db();
lookup_add($db, 777);
$replies = ['https://zkillboard.com/api/killID/777/' => [200, '[]', []]];
$ready();
check('fail: zKillboard does not know the kill', [zk_lookup_run_one($db), lookup_row($db, 777)['status'], lookup_row($db, 777)['error']],
    ['kill lookup 777: zKillboard: unknown kill', 'failed', 'zKillboard: unknown kill']);
$db->exec("UPDATE zkill_kill_lookup SET status = 'queued' WHERE killID = 777");
$replies = ['https://zkillboard.com/api/killID/777/' => [503, 'busy', []]];
$ready();
zk_lookup_run_one($db);
check('fail: HTTP error, attempts count up', [lookup_row($db, 777)['status'], lookup_row($db, 777)['error'], (int) lookup_row($db, 777)['attempts']], ['failed', 'zKillboard: HTTP 503', 2]);
$db->exec("UPDATE zkill_kill_lookup SET status = 'queued' WHERE killID = 777");
$replies = ['https://zkillboard.com/api/killID/777/' => [200, json_encode([['killmail_id' => 777, 'zkb' => ['hash' => '../../evil']]]), []]];
$ready();
$calls = [];
zk_lookup_run_one($db);
check('fail: a hash that is not hex is never put in a URL', [lookup_row($db, 777)['error'], count($calls)], ['zKillboard: no hash', 1]);
$db->exec("UPDATE zkill_kill_lookup SET status = 'queued', attempts = 0 WHERE killID = 777");
$replies = [
    'https://zkillboard.com/api/killID/777/' => [200, json_encode([['killmail_id' => 777, 'zkb' => ['hash' => 'beef']]]), []],
    'https://esi.evetech.net/killmails/777/beef/' => [422, '{"error":"Invalid killmail_id and/or killmail_hash"}', []],
];
$ready();
zk_lookup_run_one($db);
check('fail: ESI error', [lookup_row($db, 777)['status'], lookup_row($db, 777)['error']], ['failed', 'ESI: HTTP 422']);
// ESI answering with a different kill is not stored
$db->exec("UPDATE zkill_kill_lookup SET status = 'queued', attempts = 0 WHERE killID = 777");
$replies['https://esi.evetech.net/killmails/777/beef/'] = [200, json_encode($esi), []];
$ready();
zk_lookup_run_one($db);
check('fail: ESI answer for another kill', [lookup_row($db, 777)['error'], (int) $db->query('SELECT COUNT(*) FROM zkill_killmails')->fetchColumn()], ['ESI: unexpected answer', 0]);
// Not sent after all (-1): straight back in the queue, the attempt doesn't count
$db->exec("UPDATE zkill_kill_lookup SET status = 'queued', attempts = 1, error = '' WHERE killID = 777");
$replies = ['https://zkillboard.com/api/killID/777/' => [-1, 'rate limited', []]];
$ready();
check('run: not sent goes back to queued', [zk_lookup_run_one($db), lookup_row($db, 777)['status'], (int) lookup_row($db, 777)['attempts']], [null, 'queued', 1]);

// Order: oldest request first
$db = lookup_db();
lookup_add($db, 3, ['requestedAt' => '2026-10-10 10:30:00']);
lookup_add($db, 1, ['requestedAt' => '2026-10-10 11:00:00']);
lookup_add($db, 2, ['requestedAt' => '2026-10-10 10:00:00']);
lookup_add($db, 4, ['status' => 'failed', 'requestedAt' => '2026-10-10 09:00:00']);
$replies = [];
$calls = [];
for ($i = 0; $i < 4; $i++) { $ready(); zk_lookup_run_one($db); }
check('run: oldest request first, failed rows skipped', $calls, [
    'https://zkillboard.com/api/killID/2/', 'https://zkillboard.com/api/killID/3/', 'https://zkillboard.com/api/killID/1/']);

// Housekeeping: abandoned running rows go back in the queue
$db = lookup_db();
lookup_add($db, 1, ['status' => 'running', 'attemptedAt' => gmdate('Y-m-d H:i:s', time() - 600)]);
lookup_add($db, 2, ['status' => 'running', 'attemptedAt' => gmdate('Y-m-d H:i:s', time() - 30)]);
zk_lookup_housekeeping($db, time());
check('housekeeping: stale running re-queued, fresh running kept', [lookup_row($db, 1)['status'], lookup_row($db, 2)['status']], ['queued', 'running']);

// Never a real host other than the two stubbed APIs
check('only zKillboard API and ESI URLs were requested', count(array_filter($calls, function ($url) {
    return strpos($url, 'https://zkillboard.com/api/') !== 0 && strpos($url, 'https://esi.evetech.net/') !== 0;
})), 0);
zk_http_transport(null, true);

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
